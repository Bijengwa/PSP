const request = require('supertest');

// Log lines go nowhere in this file.
jest.mock('../logger', () => {
  const actual = jest.requireActual('../logger');
  return { ...actual, logger: actual.createLogger({ env: 'test', level: 'info', destination: { write: () => {} } }) };
});

// In-memory stand-in for the node-redis client, covering the commands the
// session store uses.
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
    multi() {
      const queued = [];
      const chain = {
        exec: async () => Promise.all(queued.map(([command, args]) => this[command](...args))),
      };
      for (const command of ['set', 'sAdd', 'expire']) {
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
const { app } = require('../server');
const { hashPassword } = require('./password');
const sessions = require('./session.store');

const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let adminId;
let staffId;
let adminCookie;
let staffCookie;

const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).set('Origin', ORIGIN).send(body),
});

beforeAll(async () => {
  await db.migrate.latest();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  const [admin] = await db('roles').insert({ name: 'admin', description: 'Full access' }).returning('id');
  const [staff] = await db('roles').insert({ name: 'staff', description: 'Staff' }).returning('id');
  const hash = await hashPassword('Correct-Horse-42!');
  const rows = await db('staff_profiles')
    .insert([
      { full_name: 'Asha Admin', email: 'a@psp.test', password_hash: hash, role_id: admin.id, must_change_password: false },
      {
        full_name: 'Sam Staff',
        email: 's@psp.test',
        phone_number: '+255 700 000 001',
        password_hash: hash,
        role_id: staff.id,
        must_change_password: false,
      },
    ])
    .returning('id');
  [adminId, staffId] = rows.map((row) => row.id);
  adminCookie = `psp_sid=${(await sessions.create({ staffId: adminId, ip: '::1', userAgent: 't' })).id}`;
  staffCookie = `psp_sid=${(await sessions.create({ staffId, ip: '::1', userAgent: 't' })).id}`;
});

beforeEach(async () => {
  await db('staff_profiles').where({ id: staffId }).update({ full_name: 'Sam Staff', phone_number: '+255 700 000 001' });
});

afterAll(async () => {
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  await db.destroy();
});

describe('GET /api/office/staff/:id', () => {
  test('returns the profile without any password data', async () => {
    const res = await as(adminCookie).get(`/api/office/staff/${staffId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.staff).toEqual({
      id: staffId,
      fullName: 'Sam Staff',
      email: 's@psp.test',
      phone: '+255 700 000 001',
      role: 'staff',
      isActive: true,
      mustChangePassword: false,
      lastLoginAt: null,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password_?hash|argon2/i);
  });

  test('unknown and malformed ids are 404', async () => {
    expect((await as(adminCookie).get(`/api/office/staff/${MISSING_ID}`)).status).toBe(404);
    expect((await as(adminCookie).get('/api/office/staff/not-a-uuid')).status).toBe(404);
  });

  test('a non-admin gets 403', async () => {
    const res = await as(staffCookie).get(`/api/office/staff/${adminId}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/office/staff/:id', () => {
  test('saves name and phone, tidied, and the next read shows them', async () => {
    const res = await as(adminCookie).patch(`/api/office/staff/${staffId}`, {
      fullName: '  Samuel   Mushi ',
      phone: ' +255 712 345 678 ',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.staff).toMatchObject({ id: staffId, fullName: 'Samuel Mushi', phone: '+255 712 345 678' });

    const read = await as(adminCookie).get(`/api/office/staff/${staffId}`);
    expect(read.body.data.staff).toMatchObject({ fullName: 'Samuel Mushi', phone: '+255 712 345 678' });
  });

  test('one field alone can be changed', async () => {
    const res = await as(adminCookie).patch(`/api/office/staff/${staffId}`, { phone: '0712 000 111' });

    expect(res.status).toBe(200);
    expect(res.body.data.staff).toMatchObject({ fullName: 'Sam Staff', phone: '0712 000 111' });
  });

  test('invalid values give a clear message per field and change nothing', async () => {
    const res = await as(adminCookie).patch(`/api/office/staff/${staffId}`, { fullName: '   ', phone: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      message: 'Check the highlighted fields.',
      code: 'VALIDATION_ERROR',
      details: {
        fullName: 'Enter the full name.',
        phone: 'Enter a valid phone number, for example +255 700 000 000.',
      },
    });
    const row = await db('staff_profiles').where({ id: staffId }).first('full_name', 'phone_number');
    expect(row).toEqual({ full_name: 'Sam Staff', phone_number: '+255 700 000 001' });
  });

  test('a name that is too long or an empty phone is refused', async () => {
    const res = await as(adminCookie).patch(`/api/office/staff/${staffId}`, { fullName: 'x'.repeat(121), phone: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ fullName: 'Use at most 120 characters.', phone: 'Enter a phone number.' });
  });

  test('other fields cannot be changed through this route', async () => {
    for (const body of [{ email: 'new@psp.test' }, { role: 'admin' }, { isActive: false }, { fullName: 'Sam', passwordHash: 'x' }]) {
      const res = await as(adminCookie).patch(`/api/office/staff/${staffId}`, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const row = await db('staff_profiles as s')
      .join('roles as r', 'r.id', 's.role_id')
      .where('s.id', staffId)
      .first('s.full_name', 's.email', 's.is_active', 'r.name as role');
    expect(row).toEqual({ full_name: 'Sam Staff', email: 's@psp.test', is_active: true, role: 'staff' });
  });

  test('an empty body is refused', async () => {
    const res = await as(adminCookie).patch(`/api/office/staff/${staffId}`, {});
    expect(res.status).toBe(400);
  });

  test('the edited person stays signed in', async () => {
    await as(adminCookie).patch(`/api/office/staff/${staffId}`, { fullName: 'Samuel Staff' });

    const me = await request(app).get('/api/auth/me').set('Cookie', staffCookie);
    expect(me.status).toBe(200);
    expect(me.body.data.staff.fullName).toBe('Samuel Staff');
  });

  test('unknown ids are 404; a non-admin gets 403; another origin is refused', async () => {
    expect((await as(adminCookie).patch(`/api/office/staff/${MISSING_ID}`, { fullName: 'Nobody' })).status).toBe(404);
    expect((await as(staffCookie).patch(`/api/office/staff/${staffId}`, { fullName: 'Myself' })).status).toBe(403);

    const foreign = await request(app)
      .patch(`/api/office/staff/${staffId}`)
      .set('Cookie', adminCookie)
      .set('Origin', 'https://evil.example')
      .send({ fullName: 'Evil' });
    expect(foreign.status).toBe(403);
    const row = await db('staff_profiles').where({ id: staffId }).first('full_name');
    expect(row.full_name).toBe('Sam Staff');
  });
});
