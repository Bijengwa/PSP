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
    // Login rate limiting counts attempts; the counters never expire here.
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
  const [admin] = await db('roles').insert({ name: 'IT', description: 'Full access' }).returning('id');
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
    for (const body of [
      { email: 'new@psp.test' },
      { role: 'IT', fullName: 'Sam' },
      { isActive: false, fullName: 'Sam' },
      { fullName: 'Sam', passwordHash: 'x' },
    ]) {
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

// ---------- helpers for the status and role tests ----------
const redis = require('../redis');
const { setStaffActive, setStaffRole } = require('./auth.service');
let roleIds;
let made = 0;

// A fresh person with one live session, so each test owns who it changes.
async function person(role = 'staff') {
  made += 1;
  const email = `p${made}@psp.test`;
  const [row] = await db('staff_profiles')
    .insert({
      full_name: `Person ${made}`,
      email,
      phone_number: '+255 700 000 100',
      password_hash: await hashPassword('Correct-Horse-42!'),
      role_id: roleIds[role],
      must_change_password: false,
    })
    .returning('id');
  const cookie = `psp_sid=${(await sessions.create({ staffId: row.id, ip: '::1', userAgent: 't' })).id}`;
  return { id: row.id, email, cookie };
}

const me = (cookie) => request(app).get('/api/auth/me').set('Cookie', cookie);
const login = (email) =>
  request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email, password: 'Correct-Horse-42!' });

beforeAll(async () => {
  const roles = await db('roles').select('id', 'name');
  roleIds = Object.fromEntries(roles.map((r) => [r.name, r.id]));
});

describe('PATCH /api/office/staff/:id { isActive }', () => {
  test('a deactivated person is refused on their very next request', async () => {
    const sam = await person();
    expect((await me(sam.cookie)).status).toBe(200);

    const res = await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.staff).toMatchObject({ id: sam.id, isActive: false });

    expect((await me(sam.cookie)).status).toBe(401);
    expect(await redis.client.sMembers(`psp:staff-sess:${sam.id}`)).toEqual([]);
    expect((await login(sam.email)).status).toBe(401);
  });

  test('every session ends, not only one, and the admin stays signed in', async () => {
    const sam = await person();
    const phone = `psp_sid=${(await sessions.create({ staffId: sam.id, ip: '::2', userAgent: 'phone' })).id}`;

    await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { isActive: false });

    expect((await me(sam.cookie)).status).toBe(401);
    expect((await me(phone)).status).toBe(401);
    expect((await me(adminCookie)).status).toBe(200);
  });

  test('the row is kept, and reactivation lets the person sign in again', async () => {
    const sam = await person();
    await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { isActive: false });
    expect(await db('staff_profiles').where({ id: sam.id }).first('is_active')).toEqual({ is_active: false });
    const remove = await request(app).delete(`/api/office/staff/${sam.id}`).set('Cookie', adminCookie).set('Origin', ORIGIN);
    expect(remove.status).toBe(404);

    const res = await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.data.staff).toMatchObject({ id: sam.id, isActive: true });
    expect((await login(sam.email)).status).toBe(200);
  });

  test('the staff list status filter follows the change', async () => {
    const sam = await person();
    await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { isActive: false });

    const inactive = await as(adminCookie).get(`/api/office/staff?status=inactive&q=${encodeURIComponent(sam.email)}`);
    expect(inactive.body.data.staff.map((s) => s.id)).toEqual([sam.id]);
  });

  test('an admin cannot deactivate themselves', async () => {
    const res = await as(adminCookie).patch(`/api/office/staff/${adminId}`, { isActive: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CANNOT_DEACTIVATE_SELF',
      message: 'You cannot deactivate your own account.',
    });
    expect((await me(adminCookie)).status).toBe(200);
  });

  test('another admin can be deactivated while one stays active', async () => {
    const other = await person('IT');
    const res = await as(adminCookie).patch(`/api/office/staff/${other.id}`, { isActive: false });

    expect(res.status).toBe(200);
    expect((await me(other.cookie)).status).toBe(401);
  });

  test('the last active admin cannot be deactivated, and keeps their sessions', async () => {
    // Over HTTP the caller is always an active admin, so this guard is reached
    // through the service (and through the race in the next test).
    const result = await setStaffActive(adminId, false, { actorId: staffId });

    expect(result).toEqual({ error: 'last_admin' });
    expect(await db('staff_profiles').where({ id: adminId }).first('is_active')).toEqual({ is_active: true });
    expect((await me(adminCookie)).status).toBe(200);
  });

  test('two admins deactivating each other at once leave one active', async () => {
    const one = await person('IT');
    const results = await Promise.all([
      setStaffActive(one.id, false, { actorId: adminId }),
      setStaffActive(adminId, false, { actorId: one.id }),
    ]);

    expect(results.filter((r) => r.error === 'last_admin')).toHaveLength(1);
    const active = await db('staff_profiles').where({ role_id: roleIds.IT, is_active: true }).select('id');
    expect(active).toHaveLength(1);

    // Put the main admin back for the tests after this one.
    if (active[0].id !== adminId) {
      await db('staff_profiles').where({ id: adminId }).update({ is_active: true });
      adminCookie = `psp_sid=${(await sessions.create({ staffId: adminId, ip: '::1', userAgent: 't' })).id}`;
    }
  });

  test('a bad value, or the status mixed with other fields, is refused and changes nothing', async () => {
    const sam = await person();
    for (const body of [{ isActive: 'false' }, { isActive: null }, { isActive: false, phone: '+255 700 000 002' }]) {
      const res = await as(adminCookie).patch(`/api/office/staff/${sam.id}`, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.isActive).toEqual(expect.any(String));
    }
    expect((await me(sam.cookie)).status).toBe(200);
  });

  test('when Redis is down the status does not change (503)', async () => {
    const sam = await person();
    const spy = jest.spyOn(redis.client, 'sMembers').mockRejectedValueOnce(new Error('connection lost'));

    const res = await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { isActive: false });
    spy.mockRestore();

    expect(res.status).toBe(503);
    expect(await db('staff_profiles').where({ id: sam.id }).first('is_active')).toEqual({ is_active: true });
  });

  test('unknown ids are 404; a non-admin gets 403; another origin is refused', async () => {
    const sam = await person();
    expect((await as(adminCookie).patch(`/api/office/staff/${MISSING_ID}`, { isActive: false })).status).toBe(404);
    expect((await as(staffCookie).patch(`/api/office/staff/${sam.id}`, { isActive: false })).status).toBe(403);

    const foreign = await request(app)
      .patch(`/api/office/staff/${sam.id}`)
      .set('Cookie', adminCookie)
      .set('Origin', 'https://evil.example')
      .send({ isActive: false });
    expect(foreign.status).toBe(403);
    expect((await me(sam.cookie)).status).toBe(200);
  });
});

// Earlier tests in this file share the login rate-limit counters (they never expire here).
function clearLoginLimits() {
  for (const key of redis.client.data.keys()) if (key.startsWith('psp:rl:')) redis.client.data.delete(key);
}

const post = (url, body, cookie) => {
  const req = request(app).post(url).set('Origin', ORIGIN);
  return (cookie ? req.set('Cookie', cookie) : req).send(body);
};
const cookieOf = (res) => res.headers['set-cookie'].find((c) => c.startsWith('psp_sid=')).split(';')[0];
const signIn = (email, password) => post('/api/auth/login', { email, password });
const office = (cookie) => request(app).get('/api/office/products').set('Cookie', cookie);

// The fields IT sees about a person, in the list and on the profile. Nothing else.
const STAFF_KEYS = ['createdAt', 'email', 'fullName', 'id', 'isActive', 'lastLoginAt', 'mustChangePassword', 'phone', 'role'];

describe('GET /api/office/staff', () => {
  const PAGE_SIZE = 25;
  let pagerIds;

  // 27 people sharing "Pager" in their name, so a search isolates them; two are inactive.
  beforeAll(async () => {
    const hash = await hashPassword('Correct-Horse-42!');
    const rows = await db('staff_profiles')
      .insert(
        Array.from({ length: 27 }, (_, i) => ({
          full_name: `Pager ${String(i + 1).padStart(2, '0')}`,
          email: `pager${i + 1}@list.test`,
          phone_number: '+255 700 000 200',
          password_hash: hash,
          role_id: roleIds.staff,
          must_change_password: false,
          is_active: i < 25,
        })),
      )
      .returning('id');
    pagerIds = rows.map((row) => row.id);
  });

  const list = (query) => as(adminCookie).get(`/api/office/staff${query}`);

  test('pages through the matches in name order, with the total of every match', async () => {
    const first = await list('?q=Pager');
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ total: 27, page: 1, pageSize: PAGE_SIZE });
    expect(first.body.data.staff).toHaveLength(PAGE_SIZE);
    expect(first.body.data.staff[0].fullName).toBe('Pager 01');

    const second = await list('?q=Pager&page=2');
    expect(second.body.data).toMatchObject({ total: 27, page: 2 });
    expect(second.body.data.staff.map((s) => s.fullName)).toEqual(['Pager 26', 'Pager 27']);

    const ids = [...first.body.data.staff, ...second.body.data.staff].map((s) => s.id);
    expect(new Set(ids).size).toBe(27);
    expect(ids.sort()).toEqual([...pagerIds].sort());

    const past = await list('?q=Pager&page=3');
    expect(past.body.data).toMatchObject({ total: 27, page: 3, staff: [] });
  });

  test('a missing or bad page number gives the first page', async () => {
    for (const page of ['0', '-2', 'abc']) {
      const res = await list(`?q=Pager&page=${page}`);
      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.staff[0].fullName).toBe('Pager 01');
    }
  });

  test('searches name and email, ignoring case', async () => {
    const byName = await list('?q=pAGER 07');
    expect(byName.body.data.staff.map((s) => s.fullName)).toEqual(['Pager 07']);

    const byEmail = await list('?q=PAGER12@LIST');
    expect(byEmail.body.data.staff.map((s) => s.email)).toEqual(['pager12@list.test']);

    const none = await list('?q=nobody-here');
    expect(none.body.data).toMatchObject({ total: 0, staff: [] });
  });

  test('a typed % or _ is matched literally', async () => {
    expect((await list('?q=%25')).body.data.total).toBe(0);
    expect((await list('?q=Pager_0')).body.data.total).toBe(0);
  });

  test('filters by status, together with the search', async () => {
    const active = await list('?q=Pager&status=active');
    expect(active.body.data.total).toBe(25);
    expect(active.body.data.staff.every((s) => s.isActive)).toBe(true);

    const inactive = await list('?q=Pager&status=inactive');
    expect(inactive.body.data.total).toBe(2);
    expect(inactive.body.data.staff.map((s) => s.fullName)).toEqual(['Pager 26', 'Pager 27']);
    expect(inactive.body.data.staff.every((s) => !s.isActive)).toBe(true);

    const all = await list('?q=Pager');
    expect(all.body.data.total).toBe(27);
  });

  test('an unknown status is refused', async () => {
    const res = await list('?status=deleted');
    expect(res.status).toBe(400);
  });

  test('responses carry no password fields', async () => {
    const res = await list('');
    expect(res.status).toBe(200);
    expect(res.body.data.staff.length).toBeGreaterThan(0);
    for (const member of res.body.data.staff) expect(Object.keys(member).sort()).toEqual(STAFF_KEYS);
    expect(JSON.stringify(res.body)).not.toMatch(/password_?hash|argon2|Correct-Horse/i);
  });

  test('only a signed-in admin gets the list', async () => {
    expect((await as(staffCookie).get('/api/office/staff')).status).toBe(403);
    expect((await request(app).get('/api/office/staff')).status).toBe(401);
  });
});

describe('POST /api/office/staff', () => {
  const register = (body, cookie = adminCookie) => post('/api/office/staff', body, cookie);
  const valid = (patch = {}) => ({
    fullName: 'Zawadi Register',
    email: 'zawadi@psp.test',
    phone: '+255 700 000 400',
    role: 'staff',
    temporaryPassword: 'Amber-Lantern-73!',
    ...patch,
  });

  beforeAll(clearLoginLimits);

  test('a duplicate email is refused clearly, whatever its case, and nothing is added', async () => {
    const first = await register(valid());
    expect(first.status).toBe(201);

    for (const email of ['zawadi@psp.test', '  ZAWADI@psp.TEST ']) {
      const again = await register(valid({ email, fullName: 'Someone Else' }));
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({
        code: 'EMAIL_TAKEN',
        message: 'Someone is already registered with this email.',
        details: { email: 'This email is already registered.' },
      });
    }
    // An existing seeded person counts too.
    expect((await register(valid({ email: 'S@psp.test' }))).status).toBe(409);

    const rows = await db('staff_profiles').where({ email: 'zawadi@psp.test' }).select('full_name');
    expect(rows).toEqual([{ full_name: 'Zawadi Register' }]);
  });

  test('a new person is forced to choose their own password at first sign-in', async () => {
    const res = await register(
      valid({ fullName: 'Baraka First', email: '  Baraka.First@PSP.test ', temporaryPassword: 'Cobalt-River-38!' }),
    );
    expect(res.status).toBe(201);
    const { staff } = res.body.data;
    expect(staff).toMatchObject({ email: 'baraka.first@psp.test', isActive: true, mustChangePassword: true });
    expect(JSON.stringify(res.body)).not.toMatch(/Cobalt-River|password_?hash|argon2/i);

    const row = await db('staff_profiles').where({ id: staff.id }).first('must_change_password', 'created_by', 'password_hash');
    expect(row.must_change_password).toBe(true);
    expect(row.created_by).toBe(adminId);
    expect(row.password_hash).toMatch(/^\$argon2/);

    // First sign-in with the temporary password: held at the password change.
    const first = await signIn('baraka.first@psp.test', 'Cobalt-River-38!');
    expect(first.status).toBe(200);
    expect(first.body.data.staff.mustChangePassword).toBe(true);
    let cookie = cookieOf(first);
    expect((await me(cookie)).body.data.staff.mustChangePassword).toBe(true);
    const held = await office(cookie);
    expect(held.status).toBe(403);
    expect(held.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // They choose their own; the office opens and the flag is cleared.
    const changed = await post(
      '/api/auth/change-password',
      { currentPassword: 'Cobalt-River-38!', newPassword: 'Velvet-Summit-62?' },
      cookie,
    );
    expect(changed.status).toBe(200);
    cookie = cookieOf(changed);
    expect((await office(cookie)).status).toBe(200);
    expect((await db('staff_profiles').where({ id: staff.id }).first('must_change_password')).must_change_password).toBe(false);

    // The temporary password no longer works.
    expect((await signIn('baraka.first@psp.test', 'Cobalt-River-38!')).status).toBe(401);
  });

  test('only a signed-in admin from the app origin can register', async () => {
    const body = valid({ email: 'blocked@psp.test' });
    expect((await register(body, staffCookie)).status).toBe(403);
    expect((await request(app).post('/api/office/staff').set('Origin', ORIGIN).send(body)).status).toBe(401);
    const foreign = await request(app)
      .post('/api/office/staff')
      .set('Cookie', adminCookie)
      .set('Origin', 'https://evil.example')
      .send(body);
    expect(foreign.status).toBe(403);
    expect(await db('staff_profiles').where({ email: 'blocked@psp.test' }).first('id')).toBeUndefined();
  });
});

describe('M4 end-to-end circle', () => {
  beforeAll(clearLoginLimits);

  test('register → temporary login → forced change → forgot → IT reset → deactivate → refused', async () => {
    // IT registers a person with a temporary password.
    const registered = await post(
      '/api/office/staff',
      {
        fullName: 'Neema Circle',
        email: 'Neema.Circle@psp.test',
        phone: '+255 700 000 300',
        role: 'staff',
        temporaryPassword: 'Tidal-Harbour-51!',
      },
      adminCookie,
    );
    expect(registered.status).toBe(201);
    const id = registered.body.data.staff.id;
    const email = 'neema.circle@psp.test';

    // The person signs in with it and is held at the password change.
    const first = await signIn(email, 'Tidal-Harbour-51!');
    expect(first.status).toBe(200);
    expect(first.body.data.staff.mustChangePassword).toBe(true);
    let cookie = cookieOf(first);
    const held = await office(cookie);
    expect(held.status).toBe(403);
    expect(held.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // They choose their own password and work in the office.
    const changed = await post(
      '/api/auth/change-password',
      { currentPassword: 'Tidal-Harbour-51!', newPassword: 'Quiet-Meadow-84?' },
      cookie,
    );
    expect(changed.status).toBe(200);
    cookie = cookieOf(changed);
    expect((await office(cookie)).status).toBe(200);
    expect((await as(cookie).get('/api/office/staff')).status).toBe(403);

    // They forget it; IT sees the request in the queue.
    expect((await post('/api/auth/forgot-password', { email })).status).toBe(200);
    const queue = await as(adminCookie).get('/api/office/reset-requests?status=pending');
    expect(queue.body.data.requests.filter((r) => r.staff?.id === id)).toHaveLength(1);

    // IT resets it from the profile: the person is signed out and the request is resolved.
    const reset = await post(`/api/office/staff/${id}/reset-password`, { temporaryPassword: 'Copper-Kettle-26#' }, adminCookie);
    expect(reset.status).toBe(200);
    expect(reset.body.data.resolvedRequests).toBe(1);
    expect(JSON.stringify(reset.body)).not.toMatch(/Copper-Kettle|password_?hash|argon2/i);
    expect((await me(cookie)).status).toBe(401);
    const after = await as(adminCookie).get('/api/office/reset-requests?status=pending');
    expect(after.body.data.requests.filter((r) => r.staff?.id === id)).toHaveLength(0);
    const row = await db('staff_profiles').where({ id }).first('password_hash', 'must_change_password');
    expect(row.must_change_password).toBe(true);
    expect(row.password_hash).toMatch(/^\$argon2/);
    expect(row.password_hash).not.toContain('Copper-Kettle');

    // The old password no longer works; the new temporary one forces a change again.
    expect((await signIn(email, 'Quiet-Meadow-84?')).status).toBe(401);
    const again = await signIn(email, 'Copper-Kettle-26#');
    expect(again.status).toBe(200);
    expect(again.body.data.staff.mustChangePassword).toBe(true);
    cookie = cookieOf(again);
    const changedAgain = await post(
      '/api/auth/change-password',
      { currentPassword: 'Copper-Kettle-26#', newPassword: 'Silver-Orchard-19%' },
      cookie,
    );
    cookie = cookieOf(changedAgain);
    expect((await office(cookie)).status).toBe(200);

    // IT deactivates the person, who is refused on the very next request and cannot sign in.
    const deactivated = await as(adminCookie).patch(`/api/office/staff/${id}`, { isActive: false });
    expect(deactivated.status).toBe(200);
    expect((await office(cookie)).status).toBe(401);
    expect((await signIn(email, 'Silver-Orchard-19%')).status).toBe(401);
  });
});

describe('GET /api/office/roles', () => {
  test('lists the existing roles, for admins only', async () => {
    const res = await as(adminCookie).get('/api/office/roles');
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual([
      { name: 'IT', description: 'Full access' },
      { name: 'staff', description: 'Staff' },
    ]);

    expect((await as(staffCookie).get('/api/office/roles')).status).toBe(403);
  });
});

describe('PATCH /api/office/staff/:id { role }', () => {
  const roleOf = async (id) =>
    (await db('staff_profiles as s').join('roles as r', 'r.id', 's.role_id').where('s.id', id).first('r.name')).name;

  // Every admin except the main one is made inactive, so the main admin is the last active one.
  const onlyMainAdminActive = () =>
    db('staff_profiles').where({ role_id: roleIds.IT }).whereNot({ id: adminId }).update({ is_active: false });

  test('a promoted person is signed out at once and signs in again as admin', async () => {
    const sam = await person();
    const phone = `psp_sid=${(await sessions.create({ staffId: sam.id, ip: '::2', userAgent: 'phone' })).id}`;

    const res = await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { role: 'IT' });
    expect(res.status).toBe(200);
    expect(res.body.data.staff).toMatchObject({ id: sam.id, role: 'IT' });

    expect((await me(sam.cookie)).status).toBe(401);
    expect((await me(phone)).status).toBe(401);
    expect(await redis.client.sMembers(`psp:staff-sess:${sam.id}`)).toEqual([]);
    expect((await me(adminCookie)).status).toBe(200);

    const again = await login(sam.email);
    expect(again.status).toBe(200);
    expect(again.body.data.staff.role).toBe('IT');
    const cookie = again.headers['set-cookie'][0].split(';')[0];
    expect((await as(cookie).get('/api/office/roles')).status).toBe(200);
  });

  test('a demoted admin is signed out and loses IT access on the next sign-in', async () => {
    const other = await person('IT');

    const res = await as(adminCookie).patch(`/api/office/staff/${other.id}`, { role: 'staff' });
    expect(res.status).toBe(200);
    expect(res.body.data.staff.role).toBe('staff');
    expect((await me(other.cookie)).status).toBe(401);

    const again = await login(other.email);
    const cookie = again.headers['set-cookie'][0].split(';')[0];
    expect((await as(cookie).get('/api/office/staff')).status).toBe(403);
  });

  test('the same role again changes nothing and keeps the sessions', async () => {
    const sam = await person();
    const res = await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { role: 'staff' });

    expect(res.status).toBe(200);
    expect(res.body.data.staff.role).toBe('staff');
    expect((await me(sam.cookie)).status).toBe(200);
  });

  test('an admin cannot remove their own admin role', async () => {
    await person('IT'); // another active admin, so only the self rule applies
    const res = await as(adminCookie).patch(`/api/office/staff/${adminId}`, { role: 'staff' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CANNOT_DEMOTE_SELF',
      message: 'You cannot remove your own IT role.',
    });
    expect(await roleOf(adminId)).toBe('IT');
    expect((await me(adminCookie)).status).toBe(200);
  });

  test('the last active admin cannot be demoted, and keeps their sessions', async () => {
    await onlyMainAdminActive();
    // Over HTTP the caller is always another active admin, so this guard is reached
    // through the service (and through the race below).
    const result = await setStaffRole(adminId, 'staff', { actorId: staffId });

    expect(result).toEqual({ error: 'last_admin' });
    expect(await roleOf(adminId)).toBe('IT');
    expect((await me(adminCookie)).status).toBe(200);
  });

  test('an inactive admin can be demoted while one active admin remains', async () => {
    const other = await person('IT');
    await onlyMainAdminActive();

    const res = await as(adminCookie).patch(`/api/office/staff/${other.id}`, { role: 'staff' });
    expect(res.status).toBe(200);
    expect(await roleOf(other.id)).toBe('staff');
  });

  test('two admins demoting each other at once leave one admin', async () => {
    await onlyMainAdminActive();
    const one = await person('IT');
    const results = await Promise.all([
      setStaffRole(one.id, 'staff', { actorId: adminId }),
      setStaffRole(adminId, 'staff', { actorId: one.id }),
    ]);

    expect(results.filter((r) => r.error === 'last_admin')).toHaveLength(1);
    const admins = await db('staff_profiles').where({ role_id: roleIds.IT, is_active: true }).select('id');
    expect(admins).toHaveLength(1);

    // Put the main admin back for the tests after this one.
    if (admins[0].id !== adminId) {
      await db('staff_profiles').where({ id: adminId }).update({ role_id: roleIds.IT });
      adminCookie = `psp_sid=${(await sessions.create({ staffId: adminId, ip: '::1', userAgent: 't' })).id}`;
    }
  });

  test('an unknown role, a bad value, or the role mixed with other fields is refused', async () => {
    const sam = await person();
    for (const body of [
      { role: 'owner' },
      { role: 'Admin' },
      { role: '' },
      { role: null },
      { role: ['IT'] },
      { role: 'IT', isActive: true },
    ]) {
      const res = await as(adminCookie).patch(`/api/office/staff/${sam.id}`, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.role).toEqual(expect.any(String));
    }
    expect(await roleOf(sam.id)).toBe('staff');
    expect((await me(sam.cookie)).status).toBe(200);
  });

  test('when Redis is down the role does not change (503)', async () => {
    const sam = await person();
    const spy = jest.spyOn(redis.client, 'sMembers').mockRejectedValueOnce(new Error('connection lost'));

    const res = await as(adminCookie).patch(`/api/office/staff/${sam.id}`, { role: 'IT' });
    spy.mockRestore();

    expect(res.status).toBe(503);
    expect(await roleOf(sam.id)).toBe('staff');
  });

  test('unknown ids are 404; a non-admin gets 403; another origin is refused', async () => {
    const sam = await person();
    expect((await as(adminCookie).patch(`/api/office/staff/${MISSING_ID}`, { role: 'IT' })).status).toBe(404);
    expect((await as(staffCookie).patch(`/api/office/staff/${staffId}`, { role: 'IT' })).status).toBe(403);

    const foreign = await request(app)
      .patch(`/api/office/staff/${sam.id}`)
      .set('Cookie', adminCookie)
      .set('Origin', 'https://evil.example')
      .send({ role: 'IT' });
    expect(foreign.status).toBe(403);
    expect(await roleOf(sam.id)).toBe('staff');
    expect(await roleOf(staffId)).toBe('staff');
  });
});

describe('the IT role (H3)', () => {
  const MIGRATION = '20261015090000_rename_admin_role_to_it.js';
  const roleName = async (id) => (await db('staff_profiles as s').join('roles as r', 'r.id', 's.role_id').where('s.id', id).first('r.name')).name;

  test('migrating down and up again renames the role, and the people who hold it keep it', async () => {
    expect(await roleName(adminId)).toBe('IT');

    await db.migrate.down({ name: MIGRATION });
    expect(await roleName(adminId)).toBe('admin');

    await db.migrate.latest();
    expect(await roleName(adminId)).toBe('IT');
    expect(await db('roles').where({ name: 'admin' }).first('id')).toBeUndefined();
  });
});

describe('permissions (H4)', () => {
  const MIGRATION = '20261015120000_create_permissions.js';
  const keysOf = async (roleName) =>
    (
      await db('role_permissions as rp')
        .join('roles as r', 'r.id', 'rp.role_id')
        .join('permissions as p', 'p.id', 'rp.permission_id')
        .where('r.name', roleName)
        .orderBy('p.key')
        .select('p.key')
    ).map((row) => row.key);
  const roleOf = async (id) =>
    (await db('staff_profiles as s').join('roles as r', 'r.id', 's.role_id').where('s.id', id).first('r.name')).name;

  beforeAll(async () => {
    // The earlier blocks truncate roles; migrating down and up grants the matrix to the
    // roles that exist now, which is also the migration's own round-trip test.
    await db.migrate.down({ name: MIGRATION });
    expect(await db.schema.hasTable('permissions')).toBe(false);
    expect(await db.schema.hasTable('role_permissions')).toBe(false);
    await db.migrate.latest();
  });

  test('IT holds every permission; Staff holds every one except registering staff', async () => {
    const all = (await db('permissions').orderBy('key').select('key')).map((row) => row.key);
    expect(all).toEqual(
      expect.arrayContaining([
        'staff.view',
        'staff.register',
        'staff.edit',
        'staff.change_role',
        'staff.deactivate',
        'staff.reset_password',
        'reset_requests.view',
        'reset_requests.manage',
        'products.view',
        'customers.view',
        'orders.view',
        'audit.view',
      ]),
    );

    expect(await keysOf('IT')).toEqual(all);
    expect(await keysOf('staff')).toEqual(all.filter((key) => key !== 'staff.register'));
  });

  test('/api/auth/me returns the permission keys of the role, read from Postgres each time', async () => {
    const asha = await me(adminCookie);
    expect(asha.body.data.staff.permissions).toEqual(await keysOf('IT'));

    const sam = await me(staffCookie);
    expect(sam.body.data.staff.permissions).toEqual(await keysOf('staff'));
    expect(sam.body.data.staff.permissions).not.toContain('staff.register');

    // Removing a key is seen on the very next request: nothing is cached.
    const row = await db('permissions').where({ key: 'audit.view' }).first('id');
    const staffRole = await db('roles').where({ name: 'staff' }).first('id');
    await db('role_permissions').where({ role_id: staffRole.id, permission_id: row.id }).del();
    expect((await me(staffCookie)).body.data.staff.permissions).not.toContain('audit.view');
    await db('role_permissions').insert({ role_id: staffRole.id, permission_id: row.id });
  });

  test('login returns the permissions too', async () => {
    const sam = await person('IT');
    const res = await login(sam.email);
    expect(res.status).toBe(200);
    expect(res.body.data.staff.permissions).toEqual(await keysOf('IT'));
  });

  test('nobody can give a role that holds more permissions than they hold', async () => {
    const sam = await person();

    // Staff lacks staff.register, which IT holds, so Staff cannot make anyone IT.
    expect(await setStaffRole(sam.id, 'IT', { actorId: staffId, actorRole: 'staff' })).toEqual({
      error: 'beyond',
      keys: ['staff.register'],
    });
    expect(await roleOf(sam.id)).toBe('staff');

    // IT can give any role, and Staff can give Staff.
    expect(await setStaffRole(sam.id, 'staff', { actorId: staffId, actorRole: 'staff' })).toMatchObject({ changed: false });
    expect(await setStaffRole(sam.id, 'IT', { actorId: adminId, actorRole: 'IT' })).toMatchObject({ changed: true });
    expect(await roleOf(sam.id)).toBe('IT');
  });

  test('registering someone into a role beyond the registrar is refused', async () => {
    const { registerStaff } = require('./auth.service');
    const result = await registerStaff({
      fullName: 'New Person',
      email: 'new.person@psp.test',
      phone: '+255 700 000 777',
      role: 'IT',
      temporaryPassword: 'Temporary-Pass-77!x',
      createdBy: staffId,
      actorRole: 'staff',
    });
    expect(result).toEqual({ error: 'beyond', keys: ['staff.register'] });
    expect(await db('staff_profiles').where({ email: 'new.person@psp.test' }).first('id')).toBeUndefined();
  });
});
