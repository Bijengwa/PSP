// In-memory stand-in for the stream commands the bus uses.
jest.mock('../logger', () => {
  const actual = jest.requireActual('../logger');
  return { ...actual, logger: actual.createLogger({ env: 'test', level: 'info', destination: { write: () => {} } }) };
});

jest.mock('../redis', () => {
  class FakeStreams {
    constructor() {
      this.reset();
    }
    reset() {
      this.streams = new Map(); // key -> [{ id, message }]
      this.groups = new Map(); // `${key}|${group}` -> { cursor, pending: Map(id -> { consumer, deliveries, idle }) }
      this.seq = 0;
    }
    async xAdd(key, id, message) {
      if (!this.streams.has(key)) this.streams.set(key, []);
      this.seq += 1;
      const entryId = `${1000 + this.seq}-0`;
      this.streams.get(key).push({ id: entryId, message: { ...message } });
      return entryId;
    }
    async xGroupCreate(key, group) {
      const gk = `${key}|${group}`;
      if (this.groups.has(gk)) throw new Error('BUSYGROUP Consumer Group name already exists');
      if (!this.streams.has(key)) this.streams.set(key, []);
      this.groups.set(gk, { cursor: 0, pending: new Map() });
      return 'OK';
    }
    async xReadGroup(group, consumer, { key }, { COUNT = 10 } = {}) {
      const g = this.groups.get(`${key}|${group}`);
      const entries = this.streams.get(key).slice(g.cursor, g.cursor + COUNT);
      g.cursor += entries.length;
      for (const entry of entries) g.pending.set(entry.id, { consumer, deliveries: 1, idle: 0 });
      return entries.length ? [{ name: key, messages: entries }] : null;
    }
    async xAck(key, group, id) {
      return this.groups.get(`${key}|${group}`).pending.delete(id) ? 1 : 0;
    }
    async xPendingRange(key, group, start, end, count, { IDLE = 0 } = {}) {
      const g = this.groups.get(`${key}|${group}`);
      return [...g.pending.entries()]
        .filter(([, p]) => p.idle >= IDLE)
        .slice(0, count)
        .map(([id, p]) => ({ id, consumer: p.consumer, millisecondsSinceLastDelivery: p.idle, deliveriesCounter: p.deliveries }));
    }
    async xClaim(key, group, consumer, minIdle, id) {
      const g = this.groups.get(`${key}|${group}`);
      const p = g.pending.get(id);
      if (!p || p.idle < minIdle) return [];
      p.deliveries += 1;
      p.idle = 0;
      p.consumer = consumer;
      return [this.streams.get(key).find((entry) => entry.id === id)];
    }
    // Test helper: pretend time passed without an acknowledgement.
    age(key, group) {
      for (const p of this.groups.get(`${key}|${group}`).pending.values()) p.idle = 61000;
    }
    pendingCount(key, group) {
      return this.groups.get(`${key}|${group}`).pending.size;
    }
  }
  return { client: new FakeStreams(), connect() {}, disconnect: async () => {} };
});

const redis = require('../redis');
const db = require('../db');
const bus = require('./event-bus');
const { audit, handleEvent, cleanMeta, GROUP } = require('../audit');

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  await db.migrate.latest();
});

beforeEach(async () => {
  redis.client.reset();
  await db('audit_logs').del();
});

afterAll(async () => {
  await db.destroy();
});

describe('publish', () => {
  test('writes the envelope fields to the stream', async () => {
    const id = await bus.publish('staff.created', { targetId: TARGET }, { actorId: ACTOR });
    expect(id).toBeTruthy();
    const [entry] = redis.client.streams.get(bus.STREAM);
    expect(bus.toEnvelope(entry.id, entry.message)).toMatchObject({
      id,
      type: 'staff.created',
      version: 1,
      actorId: ACTOR,
      payload: { targetId: TARGET },
    });
  });

  test('a failed publish is swallowed and returns null', async () => {
    const spy = jest.spyOn(redis.client, 'xAdd').mockRejectedValueOnce(new Error('connection lost'));
    await expect(bus.publish('auth.login_failed', { ip: '::1' })).resolves.toBeNull();
    spy.mockRestore();
  });

  test('audit() never throws when Redis has no stream support at all', async () => {
    const original = redis.client.xAdd;
    redis.client.xAdd = undefined; // calling it throws synchronously
    await expect(audit('auth.logged_out', {}, { actorId: ACTOR })).resolves.toBeNull();
    redis.client.xAdd = original;
  });
});

describe('audit consumer', () => {
  const options = { group: GROUP, consumer: 'test', handler: handleEvent, block: 0 };

  test('writes each event once, with actor, target, ip and meta', async () => {
    await audit('staff.updated', { targetId: TARGET, ip: '10.0.0.1', changed: ['role'] }, { actorId: ACTOR });
    await bus.ensureGroup(redis.client, GROUP);
    await bus.pollOnce(redis.client, options);

    const rows = await db('audit_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'staff.updated', actor_id: ACTOR, target_id: TARGET, ip: '10.0.0.1' });
    expect(rows[0].meta).toEqual({ changed: ['role'] });
    expect(redis.client.pendingCount(bus.STREAM, GROUP)).toBe(0);
  });

  test('an event delivered twice is logged once', async () => {
    const event = { id: '5-0', type: 'auth.logged_out', occurredAt: new Date().toISOString(), actorId: ACTOR, payload: {} };
    await handleEvent(event);
    await handleEvent(event);
    expect(await db('audit_logs').count({ n: '*' }).first()).toEqual({ n: '1' });
  });

  test('credential-looking keys never reach meta', async () => {
    await handleEvent({
      id: '6-0',
      type: 'staff.created',
      occurredAt: new Date().toISOString(),
      actorId: ACTOR,
      payload: { targetId: TARGET, temporaryPassword: 'x', nested: { password_hash: 'y', keep: 1 }, sessionId: 'z' },
    });
    const [row] = await db('audit_logs');
    expect(row.meta).toEqual({ nested: { keep: 1 } });
    expect(cleanMeta({ token: 1, ok: 2 })).toEqual({ ok: 2 });
  });

  test('an unknown actor or target id becomes null instead of failing the insert', async () => {
    await handleEvent({
      id: '7-0',
      type: 'auth.login_failed',
      occurredAt: new Date().toISOString(),
      actorId: null,
      payload: { targetId: 'not-a-uuid', email: 'x@psp.test' },
    });
    const [row] = await db('audit_logs');
    expect(row).toMatchObject({ actor_id: null, target_id: null });
    expect(row.meta).toEqual({ email: 'x@psp.test' });
  });

  test('an event whose handler failed stays pending and is claimed again', async () => {
    await audit('product.updated', {}, { actorId: ACTOR });
    await bus.ensureGroup(redis.client, GROUP);
    const failing = { ...options, handler: async () => { throw new Error('db down'); } };
    await bus.pollOnce(redis.client, failing);
    expect(redis.client.pendingCount(bus.STREAM, GROUP)).toBe(1);

    redis.client.age(bus.STREAM, GROUP);
    await bus.reclaim(redis.client, GROUP, 'test', handleEvent);
    expect(redis.client.pendingCount(bus.STREAM, GROUP)).toBe(0);
    expect(await db('audit_logs')).toHaveLength(1);
  });

  test('after 5 failed deliveries an event goes to the dead-letter stream', async () => {
    await audit('product.updated', {}, { actorId: ACTOR });
    await bus.ensureGroup(redis.client, GROUP);
    const failing = async () => { throw new Error('always'); };
    await bus.pollOnce(redis.client, { ...options, handler: failing });
    for (let i = 0; i < 4; i += 1) {
      redis.client.age(bus.STREAM, GROUP);
      await bus.reclaim(redis.client, GROUP, 'test', failing);
    }
    redis.client.age(bus.STREAM, GROUP);
    await bus.reclaim(redis.client, GROUP, 'test', failing);

    expect(redis.client.pendingCount(bus.STREAM, GROUP)).toBe(0);
    expect(redis.client.streams.get(bus.DEAD_STREAM)).toHaveLength(1);
    expect(await db('audit_logs')).toHaveLength(0);
  });
});
