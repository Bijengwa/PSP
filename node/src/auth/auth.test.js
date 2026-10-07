const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// Every log line the API writes during this file, exactly as it would reach stdout.
const mockLogLines = [];
jest.mock('../logger', () => {
  const actual = jest.requireActual('../logger');
  return {
    ...actual,
    logger: actual.createLogger({ env: 'test', level: 'info', destination: { write: (line) => mockLogLines.push(line) } }),
  };
});

// In-memory stand-in for the node-redis client, covering the commands the
// session store uses. `failing = true` makes every command reject, like a
// client whose connection is down with the offline queue disabled.
jest.mock('../redis', () => {
  class FakeRedis {
    constructor() {
      this.flush();
    }
    flush() {
      this.data = new Map();
      this.expiry = new Map();
      this.failing = false;
    }
    check() {
      if (this.failing) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    }
    alive(key) {
      const at = this.expiry.get(key);
      if (at !== undefined && at <= Date.now()) {
        this.data.delete(key);
        this.expiry.delete(key);
      }
      return this.data.has(key);
    }
    ttl(key) {
      return this.alive(key) && this.expiry.has(key) ? Math.ceil((this.expiry.get(key) - Date.now()) / 1000) : -1;
    }
    async ping() {
      this.check();
      return 'PONG';
    }
    async get(key) {
      this.check();
      return this.alive(key) ? this.data.get(key) : null;
    }
    async set(key, value, options) {
      this.check();
      this.data.set(key, value);
      this.expiry.delete(key);
      if (options?.expiration) this.expiry.set(key, Date.now() + options.expiration.value * 1000);
      return 'OK';
    }
    async getDel(key) {
      const value = await this.get(key);
      this.data.delete(key);
      this.expiry.delete(key);
      return value;
    }
    async del(keys) {
      this.check();
      let removed = 0;
      for (const key of [].concat(keys)) {
        if (this.alive(key)) removed += 1;
        this.data.delete(key);
        this.expiry.delete(key);
      }
      return removed;
    }
    async sAdd(key, member) {
      this.check();
      if (!this.alive(key)) this.data.set(key, new Set());
      this.data.get(key).add(member);
      return 1;
    }
    async sRem(key, member) {
      this.check();
      return this.alive(key) && this.data.get(key).delete(member) ? 1 : 0;
    }
    async sMembers(key) {
      this.check();
      return this.alive(key) ? [...this.data.get(key)] : [];
    }
    async expire(key, seconds) {
      this.check();
      if (!this.alive(key)) return 0;
      this.expiry.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    multi() {
      const queued = [];
      const chain = new Proxy(
        {},
        {
          get: (_, name) =>
            name === 'exec'
              ? async () => {
                  this.check();
                  const results = [];
                  for (const [command, args] of queued) results.push(await this[command](...args));
                  return results;
                }
              : (...args) => {
                  queued.push([name, args]);
                  return chain;
                },
        },
      );
      return chain;
    }
  }
  return { client: new FakeRedis(), connect() {}, disconnect: async () => {} };
});

const db = require('../db');
const redis = require('../redis');
const { app, errorHandler } = require('../server');
const { hashPassword } = require('./password');
const sessions = require('./session.store');
const { requireAuth, requireRole } = require('./auth.middleware');

const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const PASSWORD = 'Correct-Horse-42!';
const ADMIN = { email: 'admin@psp.test', fullName: 'Asha Admin' };
const INACTIVE = { email: 'former@psp.test', fullName: 'Former Staff' };

let adminId;
let passwordHash;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sessionCookieFrom(res) {
  return (res.headers['set-cookie'] || []).find((c) => c.startsWith('psp_sid='));
}

function sessionIdFrom(res) {
  return sessionCookieFrom(res)?.split(';')[0].slice('psp_sid='.length) || null;
}

function postLogin(body) {
  return request(app).post('/api/auth/login').set('Origin', ORIGIN).send(body);
}

async function loginAsAdmin() {
  const res = await postLogin({ email: ADMIN.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return sessionIdFrom(res);
}

function me(sessionId) {
  const req = request(app).get('/api/auth/me');
  return sessionId ? req.set('Cookie', `psp_sid=${sessionId}`) : req;
}

beforeAll(async () => {
  await db.migrate.latest();
  await db.raw('truncate staff_profiles, roles restart identity cascade');

  const [role] = await db('roles').insert({ name: 'admin', description: 'Full access' }).returning('id');
  passwordHash = await hashPassword(PASSWORD);
  const [admin] = await db('staff_profiles')
    .insert([
      { full_name: ADMIN.fullName, email: ADMIN.email, password_hash: passwordHash, role_id: role.id, must_change_password: false },
      { full_name: INACTIVE.fullName, email: INACTIVE.email, password_hash: passwordHash, role_id: role.id, is_active: false },
    ])
    .returning('id');
  adminId = admin.id;
});

beforeEach(async () => {
  redis.client.flush();
  await db('staff_profiles').where({ id: adminId }).update({ is_active: true, must_change_password: false });
});

afterAll(async () => {
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  await db.destroy();
});

describe('POST /api/auth/login', () => {
  test('valid credentials return the staff profile and set a secure session cookie', async () => {
    const res = await postLogin({ email: ADMIN.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        staff: { id: adminId, fullName: ADMIN.fullName, email: ADMIN.email, role: 'admin', mustChangePassword: false },
      },
    });
    expect(res.text).not.toContain('password_hash');
    expect(res.text).not.toContain('$argon2');

    const cookie = sessionCookieFrom(res);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(sessionIdFrom(res)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('creates the session in Redis under the hash of its ID, never the raw ID', async () => {
    const before = Date.now();
    const sessionId = await loginAsAdmin();

    const key = `psp:sess:${sha256(sessionId)}`;
    const stored = JSON.parse(await redis.client.get(key));
    expect(stored).toMatchObject({ staffId: adminId });
    expect(stored.absoluteExpiresAt).toBeGreaterThanOrEqual(before + 12 * 60 * 60 * 1000);
    // Only who is logged in: role and account state are always read from Postgres.
    expect(Object.keys(stored).sort()).toEqual(['absoluteExpiresAt', 'createdAt', 'ip', 'refreshedAt', 'staffId', 'userAgent']);
    expect(redis.client.ttl(key)).toBe(8 * 60 * 60);
    expect(await redis.client.sMembers(`psp:staff-sess:${adminId}`)).toEqual([sha256(sessionId)]);
    expect([...redis.client.data.keys()].some((k) => k.includes(sessionId))).toBe(false);

    const row = await db('staff_profiles').where({ id: adminId }).first('last_login_at');
    expect(row.last_login_at).not.toBeNull();
  });

  test('the email is matched case-insensitively', async () => {
    const res = await postLogin({ email: '  ADMIN@PSP.test ', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  test('every login issues a new session ID and ends the previous one', async () => {
    const first = await loginAsAdmin();
    const res = await postLogin({ email: ADMIN.email, password: PASSWORD }).set('Cookie', `psp_sid=${first}`);
    const second = sessionIdFrom(res);

    expect(second).not.toBe(first);
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
  });

  describe('failures all look the same and create no session', () => {
    const cases = [
      ['wrong password', { email: ADMIN.email, password: 'Wrong-Password-1!' }],
      ['unknown email', { email: 'nobody@psp.test', password: PASSWORD }],
      ['deactivated account with the right password', { email: INACTIVE.email, password: PASSWORD }],
    ];

    test.each(cases)('%s', async (_, body) => {
      const res = await postLogin(body);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: { message: 'Invalid email or password' } });
      expect(sessionCookieFrom(res)).toBeUndefined();
      expect(redis.client.data.size).toBe(0);
    });
  });

  test('missing fields are rejected with 400', async () => {
    for (const body of [{}, { email: ADMIN.email }, { password: PASSWORD }, { email: 42, password: PASSWORD }]) {
      const res = await postLogin(body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Email and password are required');
    }
  });

  test('a request from another origin is refused (CSRF)', async () => {
    const foreign = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: ADMIN.email, password: PASSWORD });
    const missing = await request(app).post('/api/auth/login').send({ email: ADMIN.email, password: PASSWORD });

    expect(foreign.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(redis.client.data.size).toBe(0);
  });
});

describe('GET /api/auth/me', () => {
  test('returns the current staff member for a valid session', async () => {
    const sessionId = await loginAsAdmin();
    const res = await me(sessionId);

    expect(res.status).toBe(200);
    expect(res.body.data.staff).toEqual({
      id: adminId,
      fullName: ADMIN.fullName,
      email: ADMIN.email,
      role: 'admin',
      mustChangePassword: false,
    });
  });

  test('returns 401 without a session cookie', async () => {
    const res = await me(null);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: { message: 'Authentication required' } });
  });

  test('returns 401 for an unknown or malformed session ID and clears the cookie', async () => {
    for (const bogus of [crypto.randomBytes(32).toString('base64url'), 'not-a-session']) {
      const res = await me(bogus);
      expect(res.status).toBe(401);
      expect(sessionCookieFrom(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    }
  });

  test('is still reachable while a password change is pending, and reports it', async () => {
    const sessionId = await loginAsAdmin();
    await db('staff_profiles').where({ id: adminId }).update({ must_change_password: true });

    const res = await me(sessionId);
    expect(res.status).toBe(200);
    expect(res.body.data.staff.mustChangePassword).toBe(true);
  });

  test('a session past its 12h absolute limit is refused and deleted', async () => {
    const sessionId = await loginAsAdmin();
    const key = `psp:sess:${sha256(sessionId)}`;
    const stored = JSON.parse(await redis.client.get(key));
    await redis.client.set(key, JSON.stringify({ ...stored, absoluteExpiresAt: Date.now() - 1 }), {
      expiration: { type: 'EX', value: 60 },
    });

    expect((await me(sessionId)).status).toBe(401);
    expect(await redis.client.get(key)).toBeNull();
  });

  test('the idle expiry slides forward, at most once a minute', async () => {
    const sessionId = await loginAsAdmin();
    const key = `psp:sess:${sha256(sessionId)}`;
    const stored = JSON.parse(await redis.client.get(key));

    // Fresh session: no write.
    await me(sessionId);
    expect(JSON.parse(await redis.client.get(key)).refreshedAt).toBe(stored.refreshedAt);

    // Last refreshed two minutes ago with a short TTL left: refreshed back to 8h.
    await redis.client.set(key, JSON.stringify({ ...stored, refreshedAt: Date.now() - 120000 }), {
      expiration: { type: 'EX', value: 30 },
    });
    await me(sessionId);
    expect(JSON.parse(await redis.client.get(key)).refreshedAt).toBeGreaterThan(stored.refreshedAt);
    expect(redis.client.ttl(key)).toBe(8 * 60 * 60);
  });
});

describe('POST /api/auth/logout', () => {
  test('deletes the session, clears the cookie, and the old cookie no longer works', async () => {
    const sessionId = await loginAsAdmin();

    const res = await request(app).post('/api/auth/logout').set('Origin', ORIGIN).set('Cookie', `psp_sid=${sessionId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: null });
    expect(sessionCookieFrom(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(await redis.client.get(`psp:sess:${sha256(sessionId)}`)).toBeNull();
    expect(await redis.client.sMembers(`psp:staff-sess:${adminId}`)).toEqual([]);
    expect((await me(sessionId)).status).toBe(401);
  });

  test('succeeds without a session, so a stale cookie can always be cleared', async () => {
    const res = await request(app).post('/api/auth/logout').set('Origin', ORIGIN);
    expect(res.status).toBe(200);
  });

  test('requires the app origin', async () => {
    const sessionId = await loginAsAdmin();
    const res = await request(app).post('/api/auth/logout').set('Cookie', `psp_sid=${sessionId}`);
    expect(res.status).toBe(403);
    expect((await me(sessionId)).status).toBe(200);
  });
});

describe('revocation', () => {
  test("revoking all of a staff member's sessions logs out every device at once", async () => {
    const laptop = await loginAsAdmin();
    const phone = await loginAsAdmin();

    await sessions.destroyAllForStaff(adminId);

    expect((await me(laptop)).status).toBe(401);
    expect((await me(phone)).status).toBe(401);
    expect(redis.client.data.size).toBe(0);
  });

  test('deactivating an account blocks its existing session on the very next request', async () => {
    const sessionId = await loginAsAdmin();
    expect((await me(sessionId)).status).toBe(200);

    await db('staff_profiles').where({ id: adminId }).update({ is_active: false });

    expect((await me(sessionId)).status).toBe(401);
    // The dead session is removed, not just refused.
    expect(await redis.client.get(`psp:sess:${sha256(sessionId)}`)).toBeNull();
  });
});

describe('protected management routes', () => {
  // A stand-in for future office routes, using the real middleware and error handler.
  const office = express();
  office.get('/office-only', requireAuth(), requireRole('admin'), (req, res) => res.json({ ok: req.staff.id }));
  office.get('/other-role', requireAuth(), requireRole('accountant'), (req, res) => res.json({ ok: true }));
  office.use(errorHandler);

  test('a valid admin session gets through', async () => {
    const sessionId = await loginAsAdmin();
    const res = await request(office).get('/office-only').set('Cookie', `psp_sid=${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: adminId });
  });

  test('no session gets 401', async () => {
    expect((await request(office).get('/office-only')).status).toBe(401);
  });

  test('a role not held gets 403', async () => {
    const sessionId = await loginAsAdmin();
    const res = await request(office).get('/other-role').set('Cookie', `psp_sid=${sessionId}`);
    expect(res.status).toBe(403);
  });

  test('a pending password change blocks everything except /me', async () => {
    const sessionId = await loginAsAdmin();
    await db('staff_profiles').where({ id: adminId }).update({ must_change_password: true });

    const res = await request(office).get('/office-only').set('Cookie', `psp_sid=${sessionId}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('POST /api/auth/change-password', () => {
  const NEW_PASSWORD = 'Fresh-Ledger-2026#';
  const office = express();
  office.get('/office-only', requireAuth(), (req, res) => res.json({ ok: true }));
  office.use(errorHandler);

  function changePassword(sessionId, body) {
    return request(app)
      .post('/api/auth/change-password')
      .set('Origin', ORIGIN)
      .set('Cookie', `psp_sid=${sessionId}`)
      .send(body);
  }

  afterEach(async () => {
    await db('staff_profiles').where({ id: adminId }).update({ password_hash: passwordHash });
  });

  test('a temporary password blocks the office until it is changed, then the office opens', async () => {
    await db('staff_profiles').where({ id: adminId }).update({ must_change_password: true });
    const temporary = await loginAsAdmin();
    const otherDevice = await loginAsAdmin();

    const blocked = await request(office).get('/office-only').set('Cookie', `psp_sid=${temporary}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const res = await changePassword(temporary, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.staff).toMatchObject({ id: adminId, mustChangePassword: false });
    expect(res.text).not.toContain('$argon2');

    const row = await db('staff_profiles').where({ id: adminId }).first('must_change_password');
    expect(row.must_change_password).toBe(false);

    // A fresh session is issued; every earlier one, on any device, has ended.
    const fresh = sessionIdFrom(res);
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await me(temporary)).status).toBe(401);
    expect((await me(otherDevice)).status).toBe(401);
    expect((await request(office).get('/office-only').set('Cookie', `psp_sid=${fresh}`)).status).toBe(200);

    expect((await postLogin({ email: ADMIN.email, password: PASSWORD })).status).toBe(401);
    expect((await postLogin({ email: ADMIN.email, password: NEW_PASSWORD })).status).toBe(200);
  });

  test('a wrong current password changes nothing and keeps the session', async () => {
    await db('staff_profiles').where({ id: adminId }).update({ must_change_password: true });
    const sessionId = await loginAsAdmin();

    const res = await changePassword(sessionId, { currentPassword: 'Not-The-Password-1!', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect((await me(sessionId)).body.data.staff.mustChangePassword).toBe(true);
  });

  test('a new password that breaks the rules is refused with the reasons', async () => {
    const sessionId = await loginAsAdmin();

    const res = await changePassword(sessionId, { currentPassword: PASSWORD, newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining(['Use at least 10 characters.', 'Include an uppercase letter.', 'Include a digit.']),
    );
    expect((await me(sessionId)).status).toBe(200);
  });

  test.each([
    ['no symbol', 'FreshLedger2026', 'Include a symbol.'],
    ['no lowercase letter', 'FRESH-LEDGER-2026#', 'Include a lowercase letter.'],
    ['part of the full name', 'Asha-Ledger-2026#', 'Do not use your name or email in the password.'],
    ['the email name', 'Admin-Ledger-2026#', 'Do not use your name or email in the password.'],
    ['a common password', 'Password123!', 'This password is too common.'],
  ])('a new password with %s is refused and the old one still works', async (_, newPassword, reason) => {
    const sessionId = await loginAsAdmin();

    const res = await changePassword(sessionId, { currentPassword: PASSWORD, newPassword });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect(res.body.error.details).toContain(reason);
    expect((await postLogin({ email: ADMIN.email, password: PASSWORD })).status).toBe(200);
  });

  test('the new password must differ from the current one', async () => {
    const sessionId = await loginAsAdmin();

    const res = await changePassword(sessionId, { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect(res.body.error.details).toEqual(['Choose a password different from the current one.']);
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect((await me(sessionId)).status).toBe(200);
  });

  test('a voluntary change ends every other session and keeps the person signed in', async () => {
    const current = await loginAsAdmin();
    const otherDevice = await loginAsAdmin();

    const res = await changePassword(current, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.staff.mustChangePassword).toBe(false);

    const fresh = sessionIdFrom(res);
    expect(fresh).not.toBe(current);
    expect((await me(otherDevice)).status).toBe(401);
    expect((await me(current)).status).toBe(401);
    expect((await me(fresh)).body.data.staff).toMatchObject({ id: adminId, mustChangePassword: false });
  });

  test('needs a session and the app origin', async () => {
    const noSession = await request(app)
      .post('/api/auth/change-password')
      .set('Origin', ORIGIN)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(noSession.status).toBe(401);

    const sessionId = await loginAsAdmin();
    const foreign = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', `psp_sid=${sessionId}`)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(foreign.status).toBe(403);
    expect((await me(sessionId)).status).toBe(200);
  });
});

describe('POST /api/auth/forgot-password', () => {
  const UNKNOWN_EMAIL = 'nobody@psp.test';

  function forgotPassword(body) {
    return request(app).post('/api/auth/forgot-password').set('Origin', ORIGIN).send(body);
  }

  // Headers that differ per request no matter what was asked.
  function stableHeaders(res) {
    const { date, 'x-request-id': _requestId, etag: _etag, ...rest } = res.headers;
    return rest;
  }

  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

  beforeEach(async () => {
    await db('password_reset_requests').del();
  });

  test('known and unknown emails get the identical answer', async () => {
    const known = await forgotPassword({ email: ADMIN.email });
    const unknown = await forgotPassword({ email: UNKNOWN_EMAIL });

    expect(known.status).toBe(200);
    expect(known.body).toEqual({ success: true, data: { message: 'If this account exists, IT has been notified.' } });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(stableHeaders(unknown)).toEqual(stableHeaders(known));
    expect(sessionCookieFrom(known)).toBeUndefined();
  });

  test('known and unknown emails take roughly the same time', async () => {
    // Warm up both paths first, so the first query of each does not skew the result.
    await forgotPassword({ email: ADMIN.email });
    await forgotPassword({ email: UNKNOWN_EMAIL });

    const timings = { known: [], unknown: [] };
    for (let i = 0; i < 15; i += 1) {
      for (const [kind, email] of [['known', ADMIN.email], ['unknown', UNKNOWN_EMAIL]]) {
        const start = process.hrtime.bigint();
        await forgotPassword({ email });
        timings[kind].push(Number(process.hrtime.bigint() - start) / 1e6);
      }
    }

    const known = median(timings.known);
    const unknown = median(timings.unknown);
    expect(Math.abs(known - unknown)).toBeLessThan(Math.max(known, unknown) * 0.5 + 15);
  });

  test('stores a pending request for a known email, linked to the staff member', async () => {
    await forgotPassword({ email: '  Admin@PSP.test ' });

    const rows = await db('password_reset_requests');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: '  Admin@PSP.test ',
      staff_id: adminId,
      status: 'pending',
      resolved_by: null,
      resolved_at: null,
    });
    expect(rows[0].requested_ip).toEqual(expect.any(String));
  });

  test('stores a request for an unknown email too, with no staff member', async () => {
    await forgotPassword({ email: UNKNOWN_EMAIL });

    const rows = await db('password_reset_requests');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: UNKNOWN_EMAIL, staff_id: null, status: 'pending' });
  });

  test('changes nothing about the account or its sessions', async () => {
    const sessionId = await loginAsAdmin();
    await forgotPassword({ email: ADMIN.email });

    expect((await me(sessionId)).status).toBe(200);
    expect((await postLogin({ email: ADMIN.email, password: PASSWORD })).status).toBe(200);
  });

  test('a missing or oversized email is rejected with 400 and nothing is stored', async () => {
    for (const body of [{}, { email: '' }, { email: '   ' }, { email: 42 }, { email: `${'a'.repeat(250)}@psp.test` }]) {
      expect((await forgotPassword(body)).status).toBe(400);
    }
    expect(await db('password_reset_requests')).toHaveLength(0);
  });

  test('requires the app origin', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .set('Origin', 'https://evil.example')
      .send({ email: ADMIN.email });
    expect(res.status).toBe(403);
    expect(await db('password_reset_requests')).toHaveLength(0);
  });
});

describe('IT password resets (/api/office)', () => {
  const TARGET = { email: 'tech@psp.test', fullName: 'Juma Technician' };
  const TEMPORARY = 'Temp-Bridge-2026!';
  let targetId;

  function asAdmin(sessionId, method, path) {
    return request(app)[method](path).set('Origin', ORIGIN).set('Cookie', `psp_sid=${sessionId}`);
  }

  function resetPassword(sessionId, staffId, temporaryPassword = TEMPORARY) {
    return asAdmin(sessionId, 'post', `/api/office/staff/${staffId}/reset-password`).send({ temporaryPassword });
  }

  async function loginAsTarget(password = PASSWORD) {
    const res = await postLogin({ email: TARGET.email, password });
    expect(res.status).toBe(200);
    return sessionIdFrom(res);
  }

  beforeAll(async () => {
    const [role] = await db('roles').insert({ name: 'staff', description: 'Office staff' }).returning('id');
    const [target] = await db('staff_profiles')
      .insert({ full_name: TARGET.fullName, email: TARGET.email, password_hash: passwordHash, role_id: role.id, must_change_password: false })
      .returning('id');
    targetId = target.id;
  });

  beforeEach(async () => {
    await db('password_reset_requests').del();
    await db('staff_profiles').where({ id: targetId }).update({ password_hash: passwordHash, must_change_password: false });
  });

  test("after a reset the person's sessions stop at once and the next login forces a change", async () => {
    const laptop = await loginAsTarget();
    const phone = await loginAsTarget();
    const admin = await loginAsAdmin();

    const res = await resetPassword(admin, targetId);
    expect(res.status).toBe(200);
    expect(res.body.data.staff).toMatchObject({ id: targetId, mustChangePassword: true });

    expect((await me(laptop)).status).toBe(401);
    expect((await me(phone)).status).toBe(401);
    expect((await postLogin({ email: TARGET.email, password: PASSWORD })).status).toBe(401);

    const next = await loginAsTarget(TEMPORARY);
    expect((await me(next)).body.data.staff.mustChangePassword).toBe(true);
    const blocked = await asAdmin(next, 'get', '/api/office/reset-requests');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // The admin's own session is untouched.
    expect((await me(admin)).status).toBe(200);
  });

  test("resolves that person's pending requests and leaves the others", async () => {
    await db('password_reset_requests').insert([
      { email: TARGET.email, staff_id: targetId },
      { email: TARGET.email, staff_id: targetId },
      { email: ADMIN.email, staff_id: adminId },
    ]);
    const admin = await loginAsAdmin();

    const res = await resetPassword(admin, targetId);
    expect(res.body.data.resolvedRequests).toBe(2);

    const rows = await db('password_reset_requests');
    for (const row of rows.filter((r) => r.staff_id === targetId)) {
      expect(row).toMatchObject({ status: 'resolved', resolved_by: adminId });
      expect(row.resolved_at).toBeInstanceOf(Date);
    }
    expect(rows.find((r) => r.staff_id === adminId)).toMatchObject({ status: 'pending', resolved_by: null });
  });

  test('a weak temporary password is refused and changes nothing', async () => {
    const session = await loginAsTarget();
    const admin = await loginAsAdmin();

    for (const weak of ['short1!A', 'alllowercase-123', 'Juma-Strong-2026!', 'Password123!']) {
      const res = await resetPassword(admin, targetId, weak);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WEAK_PASSWORD');
      expect(res.body.error.details.length).toBeGreaterThan(0);
    }
    expect((await resetPassword(admin, targetId, '')).status).toBe(400);

    expect((await me(session)).status).toBe(200);
    const row = await db('staff_profiles').where({ id: targetId }).first('password_hash', 'must_change_password');
    expect(row).toEqual({ password_hash: passwordHash, must_change_password: false });
  });

  test('an unknown or malformed staff ID is 404', async () => {
    const admin = await loginAsAdmin();
    expect((await resetPassword(admin, crypto.randomUUID())).status).toBe(404);
    expect((await resetPassword(admin, 'not-a-uuid')).status).toBe(404);
  });

  test('the queue lists pending requests oldest first, with the matching person or none', async () => {
    await db('password_reset_requests').insert([
      { email: 'stranger@psp.test', staff_id: null, created_at: new Date('2026-10-07T08:00:00Z') },
      { email: TARGET.email, staff_id: targetId, created_at: new Date('2026-10-07T07:00:00Z') },
      { email: ADMIN.email, staff_id: adminId, status: 'dismissed' },
    ]);
    const admin = await loginAsAdmin();

    const res = await asAdmin(admin, 'get', '/api/office/reset-requests?status=pending');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.requests).toEqual([
      expect.objectContaining({
        email: TARGET.email,
        status: 'pending',
        staff: { id: targetId, fullName: TARGET.fullName, isActive: true },
      }),
      expect.objectContaining({ email: 'stranger@psp.test', staff: null }),
    ]);

    expect((await asAdmin(admin, 'get', '/api/office/reset-requests?status=bogus')).status).toBe(400);
  });

  test('dismissing a request takes it out of the queue, once', async () => {
    const [pending] = await db('password_reset_requests').insert({ email: 'stranger@psp.test' }).returning('id');
    const admin = await loginAsAdmin();
    const dismiss = (id) => asAdmin(admin, 'post', `/api/office/reset-requests/${id}/dismiss`);

    expect((await dismiss(pending.id)).status).toBe(200);
    expect(await db('password_reset_requests').where({ id: pending.id }).first()).toMatchObject({
      status: 'dismissed',
      resolved_by: adminId,
    });
    expect((await asAdmin(admin, 'get', '/api/office/reset-requests')).body.data.total).toBe(0);

    expect((await dismiss(pending.id)).status).toBe(409);
    expect((await dismiss(crypto.randomUUID())).status).toBe(404);
    expect((await dismiss('nope')).status).toBe(404);
  });

  test('only a signed-in admin from the app origin gets in', async () => {
    const staff = await loginAsTarget();
    const admin = await loginAsAdmin();

    expect((await request(app).get('/api/office/reset-requests')).status).toBe(401);
    expect((await asAdmin(staff, 'get', '/api/office/reset-requests')).status).toBe(403);
    expect((await resetPassword(staff, adminId)).status).toBe(403);

    const crossSite = await request(app)
      .post(`/api/office/staff/${targetId}/reset-password`)
      .set('Origin', 'https://evil.example')
      .set('Cookie', `psp_sid=${admin}`)
      .send({ temporaryPassword: TEMPORARY });
    expect(crossSite.status).toBe(403);
    expect((await db('staff_profiles').where({ id: targetId }).first()).must_change_password).toBe(false);
  });

  test('with Redis down the reset fails closed and changes nothing', async () => {
    const admin = await loginAsAdmin();
    redis.client.failing = true;

    expect((await resetPassword(admin, targetId)).status).toBe(503);
    redis.client.failing = false;
    const row = await db('staff_profiles').where({ id: targetId }).first('password_hash', 'must_change_password');
    expect(row).toEqual({ password_hash: passwordHash, must_change_password: false });
  });

  test('the temporary password never reaches the logs', async () => {
    mockLogLines.length = 0;
    const admin = await loginAsAdmin();
    const res = await resetPassword(admin, targetId);
    expect(res.status).toBe(200);

    const logged = mockLogLines.join('\n');
    expect(logged).toContain('staff.password_reset');
    expect(logged).not.toContain(TEMPORARY);
  });
});

describe('when Redis is unavailable', () => {
  test('login fails closed with 503 and sets no cookie', async () => {
    redis.client.failing = true;
    const res = await postLogin({ email: ADMIN.email, password: PASSWORD });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: { message: 'Service temporarily unavailable' } });
    expect(sessionCookieFrom(res)).toBeUndefined();
  });

  test('an existing session is refused with 503, never let through', async () => {
    const sessionId = await loginAsAdmin();
    redis.client.failing = true;

    const res = await me(sessionId);
    expect(res.status).toBe(503);
    expect(res.body.data).toBeUndefined();
  });

  test('the health check reports Redis down but the API stays up for the shop', async () => {
    redis.client.failing = true;
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ database: 'ok', redis: 'down' });
  });
});

describe('logging', () => {
  async function waitForLine(predicate, timeoutMs = 2000) {
    const started = Date.now();
    while (!mockLogLines.some((line) => predicate(JSON.parse(line)))) {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for log line');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test('passwords, session IDs, cookies and hashes never reach the logs', async () => {
    mockLogLines.length = 0;
    const wrongPassword = 'Wrong-S3cret-77777';

    await postLogin({ email: ADMIN.email, password: wrongPassword });
    const login = await postLogin({ email: ADMIN.email, password: PASSWORD });
    const sessionId = sessionIdFrom(login);
    await me(sessionId);
    const logout = await request(app).post('/api/auth/logout').set('Origin', ORIGIN).set('Cookie', `psp_sid=${sessionId}`);
    await waitForLine((line) => line.reqId === logout.headers['x-request-id'] && line.res);

    const text = mockLogLines.join('');
    for (const secret of [PASSWORD, wrongPassword, sessionId, sha256(sessionId), '$argon2']) {
      expect(text).not.toContain(secret);
    }

    // The auth events are there, tied to their request IDs.
    const lines = mockLogLines.map((line) => JSON.parse(line));
    const events = lines.filter((line) => line.event).map((line) => line.event);
    expect(events).toEqual(['auth.login_failed', 'auth.login_succeeded', 'auth.logged_out']);
    const success = lines.find((line) => line.event === 'auth.login_succeeded');
    expect(success.reqId).toBe(login.headers['x-request-id']);
    expect(success.staffId).toBe(adminId);
  });

  test('a Redis outage is logged with the request ID', async () => {
    mockLogLines.length = 0;
    redis.client.failing = true;
    const res = await postLogin({ email: ADMIN.email, password: PASSWORD });
    await waitForLine((line) => line.msg === 'Unhandled error' && line.reqId === res.headers['x-request-id']);
  });
});
