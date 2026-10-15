const request = require('supertest');

jest.mock('../logger', () => {
  const actual = jest.requireActual('../logger');
  return { ...actual, logger: actual.createLogger({ env: 'test', level: 'info', destination: { write: () => {} } }) };
});

// In-memory stand-in for the node-redis client (the commands the session store uses).
jest.mock('../redis', () => {
  class FakeRedis {
    constructor() {
      this.data = new Map();
    }
    async get(key) {
      return this.data.has(key) ? this.data.get(key) : null;
    }
    async set(key, value) {
      this.data.set(key, value);
      return 'OK';
    }
    async getDel(key) {
      const value = await this.get(key);
      this.data.delete(key);
      return value;
    }
    async del(keys) {
      let removed = 0;
      for (const key of [].concat(keys)) if (this.data.delete(key)) removed += 1;
      return removed;
    }
    async sAdd(key, member) {
      if (!this.data.has(key)) this.data.set(key, new Set());
      this.data.get(key).add(member);
      return 1;
    }
    async sRem(key, member) {
      return this.data.get(key)?.delete(member) ? 1 : 0;
    }
    async sMembers(key) {
      return [...(this.data.get(key) ?? [])];
    }
    async expire() {
      return 1;
    }
    async incr(key) {
      const next = Number(this.data.get(key) ?? 0) + 1;
      this.data.set(key, String(next));
      return next;
    }
    async ttl() {
      return 900;
    }
    multi() {
      const queued = [];
      const chain = {
        exec: async () => Promise.all(queued.map(([command, args]) => this[command](...args))),
      };
      for (const command of ['set', 'sAdd', 'expire', 'incr', 'ttl']) {
        chain[command] = (...args) => {
          queued.push([command, args]);
          return chain;
        };
      }
      return chain;
    }
  }
  return { client: new FakeRedis(), connect() {}, disconnect: async () => {} };
});

const db = require('../db');
const { grantMatrix } = require('./permissions.testing');
const { app } = require('../server');
const { hashPassword } = require('./password');
const sessions = require('./session.store');

const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const ID = '00000000-0000-4000-8000-000000000000';

// Every office endpoint and the permission keys it needs (H5). A request from someone
// who holds every permission except one of these keys must get 403.
const ENDPOINTS = [
  ['get', '/api/office/staff', ['staff.view']],
  ['get', `/api/office/staff/${ID}`, ['staff.view']],
  ['get', '/api/office/roles', ['staff.view']],
  ['post', '/api/office/staff', ['staff.register'], {}],
  ['patch', `/api/office/staff/${ID}`, ['staff.edit'], { fullName: 'Someone' }],
  ['patch', `/api/office/staff/${ID}`, ['staff.deactivate'], { isActive: false }],
  ['patch', `/api/office/staff/${ID}`, ['staff.change_role'], { role: 'staff' }],
  ['post', `/api/office/staff/${ID}/reset-password`, ['staff.reset_password'], { temporaryPassword: 'x' }],
  ['get', '/api/office/reset-requests', ['reset_requests.view']],
  ['post', `/api/office/reset-requests/${ID}/dismiss`, ['reset_requests.manage'], {}],

  ['get', '/api/office/products/categories', ['products.view']],
  ['get', '/api/office/products', ['products.view']],
  ['get', `/api/office/products/${ID}`, ['products.view']],
  ['post', '/api/office/products', ['products.create'], {}],
  ['patch', `/api/office/products/${ID}`, ['products.edit'], { name: 'X' }],
  ['post', `/api/office/products/${ID}/images`, ['products.edit'], {}],
  ['put', `/api/office/products/${ID}/images/order`, ['products.edit'], { imageIds: [] }],
  ['delete', `/api/office/products/${ID}/images/${ID}`, ['products.edit']],

  ['get', '/api/office/customers', ['customers.view']],
  ['get', '/api/office/customers/duplicates', ['customers.view']],
  ['get', `/api/office/customers/${ID}`, ['customers.view']],
  ['post', '/api/office/customers', ['customers.create'], {}],
  ['patch', `/api/office/customers/${ID}`, ['customers.edit'], { name: 'X' }],

  ['get', '/api/office/orders', ['orders.view']],
  ['get', `/api/office/orders/${ID}`, ['orders.view']],
  ['post', '/api/office/orders', ['orders.create'], {}],
  ['post', `/api/office/orders/${ID}/status`, ['orders.update'], { status: 'confirmed' }],
  ['post', `/api/office/orders/${ID}/paid`, ['orders.update'], {}],
  ['put', `/api/office/orders/${ID}/items`, ['orders.update'], { items: [] }],
  ['put', `/api/office/orders/${ID}/customer`, ['orders.link'], { customerId: ID }],
  ['post', `/api/office/orders/${ID}/customer`, ['orders.link', 'customers.create'], {}],
  ['delete', `/api/office/orders/${ID}/customer`, ['orders.link']],
];

let allKeys;
let limitedRoleId;
let cookie;
let staffCookie;
let itCookie;
let staffTargetId;
let itTargetId;

const send = (method, url, body, withCookie = cookie) => {
  const req = request(app)[method](url).set('Cookie', withCookie).set('Origin', ORIGIN);
  return method === 'get' || method === 'delete' ? req : req.send(body ?? {});
};

async function setKeys(keys) {
  await db('role_permissions').where({ role_id: limitedRoleId }).del();
  const rows = await db('permissions').whereIn('key', keys).select('id');
  if (rows.length) {
    await db('role_permissions').insert(rows.map((row) => ({ role_id: limitedRoleId, permission_id: row.id })));
  }
}

async function signInAs(staffId) {
  return `psp_sid=${(await sessions.create({ staffId, ip: '::1', userAgent: 't' })).id}`;
}

beforeAll(async () => {
  await db.migrate.latest();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  const [it] = await db('roles').insert({ name: 'IT', description: 'Full access' }).returning('id');
  const [staff] = await db('roles').insert({ name: 'staff', description: 'Staff' }).returning('id');
  const [limited] = await db('roles').insert({ name: 'limited', description: 'Test role' }).returning('id');
  limitedRoleId = limited.id;
  await grantMatrix();
  allKeys = (await db('permissions').select('key')).map((row) => row.key);

  const hash = await hashPassword('Correct-Horse-42!');
  const person = (name, roleId) => ({
    full_name: name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@psp.test`,
    phone_number: '+255 700 000 001',
    password_hash: hash,
    role_id: roleId,
    must_change_password: false,
  });
  const rows = await db('staff_profiles')
    .insert([person('Pat Limited', limited.id), person('Sam Staff', staff.id), person('Ivy IT', it.id), person('Tom Staff', staff.id)])
    .returning('id');
  cookie = await signInAs(rows[0].id);
  staffCookie = await signInAs(rows[1].id);
  itTargetId = rows[2].id;
  staffTargetId = rows[3].id;
  itCookie = await signInAs(rows[2].id);
});

afterAll(async () => {
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  await db.destroy();
});

describe('every office endpoint returns 403 without its permission', () => {
  test.each(ENDPOINTS.flatMap(([method, url, keys, body]) => keys.map((key) => [method, url, key, body])))(
    '%s %s without %s',
    async (method, url, missing, body) => {
      await setKeys(allKeys.filter((key) => key !== missing));
      const res = await send(method, url, body);
      expect(res.status).toBe(403);
    },
  );

  test('a role with no permission at all is refused everywhere', async () => {
    await setKeys([]);
    for (const [method, url, , body] of ENDPOINTS) {
      expect((await send(method, url, body)).status).toBe(403);
    }
  });

  test('holding the key is enough to pass the gate (the request then fails on its own merits)', async () => {
    for (const [method, url, keys, body] of ENDPOINTS) {
      await setKeys(keys);
      const res = await send(method, url, body);
      expect({ method, url, status: res.status }).not.toMatchObject({ status: 403 });
    }
  });

  test('permissions are read from Postgres on every request', async () => {
    await setKeys(['products.view']);
    expect((await send('get', '/api/office/products')).status).toBe(200);
    await setKeys([]);
    expect((await send('get', '/api/office/products')).status).toBe(403);
  });

  test('no session is 401 and a foreign origin is 403, whatever the permissions', async () => {
    await setKeys(allKeys);
    expect((await request(app).get('/api/office/products')).status).toBe(401);
    const foreign = await request(app)
      .post('/api/office/products')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({});
    expect(foreign.status).toBe(403);
  });
});

describe('Staff cannot act on an IT account', () => {
  const profile = async (id) => db('staff_profiles').where({ id }).first('full_name', 'is_active', 'password_hash', 'role_id');

  test('edit, deactivate, role change and password reset on an IT account are 403 and change nothing', async () => {
    const before = await profile(itTargetId);
    const attempts = [
      send('patch', `/api/office/staff/${itTargetId}`, { fullName: 'Hijacked' }, staffCookie),
      send('patch', `/api/office/staff/${itTargetId}`, { isActive: false }, staffCookie),
      send('patch', `/api/office/staff/${itTargetId}`, { role: 'staff' }, staffCookie),
      send('post', `/api/office/staff/${itTargetId}/reset-password`, { temporaryPassword: 'Copper-Kettle-26#' }, staffCookie),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    expect(await profile(itTargetId)).toEqual(before);
  });

  test('Staff cannot make anyone IT, and cannot register anyone', async () => {
    const res = await send('patch', `/api/office/staff/${staffTargetId}`, { role: 'IT' }, staffCookie);
    expect(res.status).toBe(403);
    expect((await send('post', '/api/office/staff', {}, staffCookie)).status).toBe(403);
  });

  test('Staff can still edit and reset another Staff account, and IT can act on IT', async () => {
    const edit = await send('patch', `/api/office/staff/${staffTargetId}`, { fullName: 'Tom Renamed' }, staffCookie);
    expect(edit.status).toBe(200);

    const reset = await send(
      'post',
      `/api/office/staff/${staffTargetId}/reset-password`,
      { temporaryPassword: 'Copper-Kettle-26#' },
      staffCookie,
    );
    expect(reset.status).toBe(200);

    const itEdit = await send('patch', `/api/office/staff/${itTargetId}`, { fullName: 'Ivy Renamed' }, itCookie);
    expect(itEdit.status).toBe(200);
  });
});

// H7: events published by the office routes, and the audit log endpoint.
describe('audit events (H7)', () => {
  const bus = require('./event-bus');
  const { handleEvent } = require('../audit');
  let publish;

  beforeEach(() => {
    publish = jest.spyOn(bus, 'publish').mockResolvedValue('1-0');
  });
  afterEach(() => publish.mockRestore());

  const published = () => publish.mock.calls.map(([type, payload, options]) => ({ type, payload, options }));
  const types = () => published().map((event) => event.type);

  test('product price, publish and archive changes name the actor and the product', async () => {
    await setKeys(allKeys);
    const category = await db('product_categories').first('id');
    const created = await send('post', '/api/office/products', {
      name: 'Audit Test Monitor',
      categoryId: category.id,
      priceTzs: 1000000,
      costPriceTzs: 800000,
    }, itCookie);
    expect(created.status).toBe(201);
    const id = created.body.data.product.id;
    expect(types()).toContain('product.created');

    publish.mockClear();
    const edit = await send('patch', `/api/office/products/${id}`, { priceTzs: 1200000, isPublished: true }, itCookie);
    expect(edit.status).toBe(200);
    expect(types()).toEqual(expect.arrayContaining(['product.updated', 'product.price_changed', 'product.published']));
    const price = published().find((event) => event.type === 'product.price_changed');
    expect(price.payload).toMatchObject({ targetId: id, field: 'priceTzs', from: 1000000, to: 1200000 });
    expect(price.options.actorId).toBe(itTargetId);

    publish.mockClear();
    await send('patch', `/api/office/products/${id}`, { isPublished: false, isArchived: true }, itCookie);
    expect(types()).toEqual(expect.arrayContaining(['product.unpublished', 'product.archived']));

    // An edit that changes nothing publishes nothing.
    publish.mockClear();
    await send('patch', `/api/office/products/${id}`, { priceTzs: 1200000 }, itCookie);
    expect(types()).toEqual([]);
  });

  test('customer events list the changed field names, not the personal details', async () => {
    await setKeys(allKeys);
    const created = await send('post', '/api/office/customers', {
      type: 'individual',
      fullName: 'Audit Person',
      phone: '0712 000 111',
    }, itCookie);
    expect(created.status).toBe(201);
    const id = created.body.data.customer.id;

    publish.mockClear();
    const edit = await send('patch', `/api/office/customers/${id}`, { fullName: 'Audit Renamed' }, itCookie);
    expect(edit.status).toBe(200);
    const [event] = published();
    expect(event.type).toBe('customer.updated');
    expect(event.payload).toMatchObject({ targetId: id, fields: ['fullName'] });
    expect(JSON.stringify(event.payload)).not.toContain('Audit Renamed');
    expect(JSON.stringify(event.payload)).not.toContain('0712');
  });

  test('staff management and password events are published without any password', async () => {
    await setKeys(allKeys);
    const reset = await send(
      'post',
      `/api/office/staff/${staffTargetId}/reset-password`,
      { temporaryPassword: 'Copper-Kettle-27#' },
      itCookie,
    );
    expect(reset.status).toBe(200);
    const role = await send('patch', `/api/office/staff/${staffTargetId}`, { isActive: false }, itCookie);
    expect(role.status).toBe(200);
    expect(types()).toEqual(expect.arrayContaining(['staff.password_reset', 'staff.deactivated']));
    expect(JSON.stringify(published())).not.toContain('Copper-Kettle');
    await send('patch', `/api/office/staff/${staffTargetId}`, { isActive: true }, itCookie);
  });

  test('a failed login is published with the email and IP, never the password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'Nobody@psp.test', password: 'Wrong-Password-99!' });
    expect(res.status).toBe(401);
    const event = published().find((item) => item.type === 'auth.login_failed');
    expect(event.payload).toMatchObject({ email: 'nobody@psp.test' });
    expect(event.payload.ip).toBeTruthy();
    expect(JSON.stringify(event)).not.toContain('Wrong-Password');
  });

  test('a publish that fails does not fail the request', async () => {
    await setKeys(allKeys);
    // The real bus: the in-memory Redis stand-in has no stream commands, so the publish fails.
    publish.mockRestore();
    const res = await send('patch', `/api/office/staff/${staffTargetId}`, { fullName: 'Tom Again' }, itCookie);
    expect(res.status).toBe(200);
  });

  describe('GET /api/office/audit-logs', () => {
    beforeAll(async () => {
      await db('audit_logs').del();
      const at = (minutes) => new Date(Date.UTC(2026, 9, 15, 8, minutes)).toISOString();
      await handleEvent({
        id: 'h7-1', type: 'order.status_changed', occurredAt: at(1), actorId: itTargetId,
        payload: { targetId: ID, status: 'confirmed', ip: '10.0.0.1' },
      });
      await handleEvent({
        id: 'h7-2', type: 'staff.deactivated', occurredAt: at(2), actorId: itTargetId,
        payload: { targetId: staffTargetId, ip: '10.0.0.1' },
      });
      await handleEvent({ id: 'h7-3', type: 'auth.login_failed', occurredAt: at(3), payload: { email: 'x@psp.test' } });
    });

    test('lists newest first with actor and target names', async () => {
      await setKeys(allKeys);
      const res = await send('get', '/api/office/audit-logs', undefined, itCookie);
      expect(res.status).toBe(200);
      const { events, total } = res.body.data;
      expect(total).toBe(3);
      expect(events.map((event) => event.type)).toEqual(['auth.login_failed', 'staff.deactivated', 'order.status_changed']);
      expect(events[1]).toMatchObject({ actorName: expect.stringContaining('Ivy'), targetName: expect.stringContaining('Tom') });
      expect(events[2].meta).toEqual({ status: 'confirmed' });
    });

    test('filters by category and rejects an unknown one', async () => {
      await setKeys(allKeys);
      const res = await send('get', '/api/office/audit-logs?category=order', undefined, itCookie);
      expect(res.body.data.events.map((event) => event.type)).toEqual(['order.status_changed']);
      expect((await send('get', '/api/office/audit-logs?category=nope', undefined, itCookie)).status).toBe(400);
    });

    test('needs audit.view', async () => {
      await setKeys(allKeys.filter((key) => key !== 'audit.view'));
      expect((await send('get', '/api/office/audit-logs')).status).toBe(403);
    });
  });
});
