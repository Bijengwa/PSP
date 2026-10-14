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
const sessions = require('../auth/session.store');
const { phoneDigits } = require('./customers.service');

const MIGRATION = '20261014200000_create_customers.js';

let staffId;
let staffCookie;

// Inserts a customer straight into the table, an individual by default.
async function customer(over = {}) {
  const [row] = await db('customers')
    .insert({ type: 'individual', full_name: 'Asha Mushi', created_by: staffId, ...over })
    .returning('*');
  return row;
}

// Resolves to the Postgres error code of a failed insert, or null if it went in.
const failure = (promise) => promise.then(
  () => null,
  (err) => err.code,
);

beforeAll(async () => {
  await db.migrate.latest();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  const [role] = await db('roles').insert({ name: 'staff', description: 'Staff' }).returning('id');
  const [staff] = await db('staff_profiles')
    .insert({ full_name: 'Sam Staff', email: 's@psp.test', password_hash: 'x', role_id: role.id, must_change_password: false })
    .returning('id');
  staffId = staff.id;
  staffCookie = `psp_sid=${(await sessions.create({ staffId, ip: '::1', userAgent: 't' })).id}`;
});

beforeEach(async () => {
  await db('customer_addresses').del();
  await db('customers').del();
});

afterAll(async () => {
  await db('customer_addresses').del();
  await db('customers').del();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  await db.destroy();
});

describe('customers table', () => {
  test('stores an individual and a company with defaults', async () => {
    const person = await customer({ phone: '+255712345678', email: 'asha@example.com' });
    expect(person).toMatchObject({ type: 'individual', full_name: 'Asha Mushi', notes: '', created_by: staffId });
    expect(person.id).toEqual(expect.any(String));
    expect(person.created_at).toBeInstanceOf(Date);
    expect(person.updated_at).toBeInstanceOf(Date);

    const company = await customer({
      type: 'company',
      full_name: null,
      company_name: 'Bugando Medical Centre',
      tin: '123-456-789',
      contact_person: 'Dr. Juma',
    });
    expect(company).toMatchObject({ type: 'company', company_name: 'Bugando Medical Centre', tin: '123-456-789' });
  });

  test('refuses an unknown type', async () => {
    expect(await failure(customer({ type: 'reseller' }))).toBe('23514');
  });

  test('an individual needs a full name and a company needs a company name', async () => {
    expect(await failure(customer({ full_name: null }))).toBe('23514');
    expect(await failure(customer({ type: 'company', full_name: 'Juma' }))).toBe('23514');
  });

  test('company fields are refused on an individual', async () => {
    expect(await failure(customer({ company_name: 'Acme' }))).toBe('23514');
    expect(await failure(customer({ tin: '123456789' }))).toBe('23514');
    expect(await failure(customer({ contact_person: 'Juma' }))).toBe('23514');
  });

  test('email must be stored lowercase', async () => {
    expect(await failure(customer({ email: 'Asha@Example.com' }))).toBe('23514');
  });

  test('phone and email may repeat (a duplicate is a warning, not an error)', async () => {
    await customer({ phone: '+255712345678', email: 'asha@example.com' });
    expect(await failure(customer({ phone: '+255712345678', email: 'asha@example.com' }))).toBeNull();
  });

  test('needs a staff member as creator', async () => {
    expect(await failure(customer({ created_by: null }))).toBe('23502');
    expect(await failure(customer({ created_by: '00000000-0000-0000-0000-000000000000' }))).toBe('23503');
  });

  test('phone and email are indexed for matching guest orders', async () => {
    const { rows } = await db.raw("select indexdef from pg_indexes where tablename = 'customers'");
    const defs = rows.map((r) => r.indexdef);
    expect(defs).toEqual(expect.arrayContaining([expect.stringMatching(/\(phone\)$/), expect.stringMatching(/\(email\)$/)]));
  });
});

describe('customer_addresses table', () => {
  const address = (customerId, over = {}) =>
    db('customer_addresses')
      .insert({ customer_id: customerId, area: 'Mwanza', address: 'Plot 12, Kenyatta Road', ...over })
      .returning('*')
      .then(([row]) => row);

  test('stores several addresses with defaults', async () => {
    const { id } = await customer();
    const first = await address(id, { is_default: true, label: 'Home' });
    const second = await address(id);
    expect(first).toMatchObject({ customer_id: id, label: 'Home', is_default: true });
    expect(second).toMatchObject({ label: '', is_default: false });
  });

  test('allows only one default address per customer', async () => {
    const { id } = await customer();
    await address(id, { is_default: true });
    expect(await failure(address(id, { is_default: true }))).toBe('23505');

    const other = await customer({ full_name: 'Other' });
    expect(await failure(address(other.id, { is_default: true }))).toBeNull();
  });

  test('needs an existing customer and goes with it', async () => {
    expect(await failure(address('00000000-0000-0000-0000-000000000000'))).toBe('23503');

    const { id } = await customer();
    await address(id);
    await db('customers').where({ id }).del();
    expect(await db('customer_addresses').where({ customer_id: id }).first()).toBeUndefined();
  });
});

describe('customers API (GET /api/office/customers)', () => {
  const list = (query = '') => request(app).get(`/api/office/customers${query}`).set('Cookie', staffCookie);

  // Three individuals and two companies, oldest first.
  async function seed() {
    const rows = [
      { full_name: 'Asha Mushi', phone: '+255712345678', email: 'asha@example.com' },
      { full_name: 'Juma Said', phone: '+255754100200', email: 'juma@mail.test' },
      { full_name: '50% Discount Person' },
      {
        type: 'company',
        full_name: null,
        company_name: 'Bugando Medical Centre',
        contact_person: 'Dr. Neema Kweka',
        tin: '123-456-789',
        phone: '+255282500000',
        email: 'procurement@bugando.test',
      },
      { type: 'company', full_name: null, company_name: 'Kilimanjaro Clinic' },
    ];
    for (const [n, row] of rows.entries()) {
      await customer({ ...row, created_at: new Date(Date.UTC(2026, 9, 1 + n)) });
    }
  }

  const names = (res) => res.body.data.customers.map((c) => c.fullName ?? c.companyName);

  test('requires a session', async () => {
    const res = await request(app).get('/api/office/customers');
    expect(res.status).toBe(401);
  });

  test('a normal staff member can use it; empty list with zero counts', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      customers: [],
      total: 0,
      page: 1,
      pageSize: 25,
      counts: { all: 0, individual: 0, company: 0 },
    });
  });

  test('lists newest first in the public shape, without notes or creator', async () => {
    await seed();
    await db('customers').where({ full_name: 'Asha Mushi' }).update({ notes: 'Prefers calls after 5pm' });
    const res = await list();
    expect(names(res)).toEqual([
      'Kilimanjaro Clinic',
      'Bugando Medical Centre',
      '50% Discount Person',
      'Juma Said',
      'Asha Mushi',
    ]);
    expect(res.body.data.counts).toEqual({ all: 5, individual: 3, company: 2 });
    const company = res.body.data.customers[1];
    expect(Object.keys(company).sort()).toEqual([
      'companyName',
      'contactPerson',
      'createdAt',
      'email',
      'fullName',
      'id',
      'phone',
      'tin',
      'type',
      'updatedAt',
    ]);
    expect(company).toMatchObject({
      type: 'company',
      fullName: null,
      companyName: 'Bugando Medical Centre',
      contactPerson: 'Dr. Neema Kweka',
      tin: '123-456-789',
      phone: '+255282500000',
      email: 'procurement@bugando.test',
    });
  });

  test('search by name, company, contact person, email and phone (any case)', async () => {
    await seed();
    expect(names(await list('?q=asha'))).toEqual(['Asha Mushi']);
    expect(names(await list('?q=BUGANDO'))).toEqual(['Bugando Medical Centre']);
    expect(names(await list('?q=kweka'))).toEqual(['Bugando Medical Centre']);
    expect(names(await list('?q=juma%40mail'))).toEqual(['Juma Said']);
    expect(names(await list('?q=%2B255754'))).toEqual(['Juma Said']);
    // Typed the local way, with spaces: 0712 345 678 is stored as +255712345678.
    expect(names(await list(`?q=${encodeURIComponent('0712 345 678')}`))).toEqual(['Asha Mushi']);
    expect(names(await list('?q=100200'))).toEqual(['Juma Said']);
    expect((await list('?q=nobody')).body.data.total).toBe(0);
  });

  test('search treats % and _ literally', async () => {
    await seed();
    expect(names(await list('?q=50%25'))).toEqual(['50% Discount Person']);
    expect((await list('?q=_')).body.data.total).toBe(0);
  });

  test('type filter; counts follow the search but not the type', async () => {
    await seed();
    let res = await list('?type=company');
    expect(names(res)).toEqual(['Kilimanjaro Clinic', 'Bugando Medical Centre']);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.counts).toEqual({ all: 5, individual: 3, company: 2 });

    res = await list('?type=individual&q=u');
    expect(names(res)).toEqual(['50% Discount Person', 'Juma Said', 'Asha Mushi']);
    expect(res.body.data.counts).toEqual({ all: 4, individual: 3, company: 1 });

    res = await list('?type=individual&q=clinic');
    expect(res.body.data).toMatchObject({ customers: [], total: 0, counts: { all: 1, individual: 0, company: 1 } });
  });

  test('an unknown type is a 400', async () => {
    const res = await list('?type=reseller');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/individual, company/);
  });

  test('pages of 25; total counts every match; bad page numbers fall back to 1', async () => {
    await db('customers').insert(
      Array.from({ length: 27 }, (_, n) => ({
        type: 'individual',
        full_name: `Customer ${String(n).padStart(2, '0')}`,
        created_by: staffId,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, n)),
      })),
    );
    const first = await list();
    expect(first.body.data).toMatchObject({ total: 27, page: 1, pageSize: 25 });
    expect(first.body.data.customers).toHaveLength(25);
    expect(first.body.data.customers[0].fullName).toBe('Customer 26');

    const second = await list('?page=2');
    expect(names(second)).toEqual(['Customer 01', 'Customer 00']);
    expect(second.body.data.page).toBe(2);

    expect((await list('?page=abc')).body.data.page).toBe(1);
    expect((await list('?page=-3')).body.data.page).toBe(1);
    expect((await list('?page=9')).body.data.customers).toEqual([]);
  });

  test('phone search digits', () => {
    expect(phoneDigits('0712 345')).toBe('255712345');
    expect(phoneDigits('+255 (712) 345-678')).toBe('255712345678');
    expect(phoneDigits('712')).toBe('712');
    expect(phoneDigits('07')).toBeNull();
    expect(phoneDigits('asha')).toBeNull();
    expect(phoneDigits('flat 12')).toBeNull();
  });
});

describe('add and edit customers (POST, GET, PATCH /api/office/customers)', () => {
  const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  const post = (body) =>
    request(app).post('/api/office/customers').set('Cookie', staffCookie).set('Origin', ORIGIN).send(body);
  const patch = (id, body) =>
    request(app).patch(`/api/office/customers/${id}`).set('Cookie', staffCookie).set('Origin', ORIGIN).send(body);
  const get = (path) => request(app).get(`/api/office/customers/${path}`).set('Cookie', staffCookie);

  test('needs a session and the same origin', async () => {
    expect((await request(app).post('/api/office/customers').set('Origin', ORIGIN).send({})).status).toBe(401);
    const noOrigin = await request(app)
      .post('/api/office/customers')
      .set('Cookie', staffCookie)
      .send({ type: 'individual', fullName: 'Asha Mushi' });
    expect(noOrigin.status).toBe(403);
    expect(await db('customers').count('* as n').first()).toEqual({ n: '0' });
  });

  test('creates an individual with normalised phone and email, notes and addresses', async () => {
    const res = await post({
      type: 'individual',
      fullName: '  Asha   Mushi ',
      phone: '0712 345 678',
      email: ' Asha.Mushi@Example.COM ',
      notes: 'Prefers calls after 4pm.',
      // Company fields sent for an individual are dropped, not stored.
      companyName: 'Ignored Ltd',
      tin: '123',
      addresses: [
        { label: 'Home', area: 'Mikocheni, Dar es Salaam', address: 'Plot 12, Old Bagamoyo Road' },
        { label: '', area: '', address: '' },
        { label: 'Shop', area: 'Kariakoo', address: 'Msimbazi Street', isDefault: false },
      ],
    });
    expect(res.status).toBe(201);
    const { customer: created } = res.body.data;
    expect(created).toMatchObject({
      type: 'individual',
      fullName: 'Asha Mushi',
      companyName: null,
      tin: null,
      contactPerson: null,
      phone: '+255712345678',
      email: 'asha.mushi@example.com',
      notes: 'Prefers calls after 4pm.',
    });
    expect(created.addresses).toEqual([
      { id: expect.any(String), label: 'Home', area: 'Mikocheni, Dar es Salaam', address: 'Plot 12, Old Bagamoyo Road', isDefault: true },
      { id: expect.any(String), label: 'Shop', area: 'Kariakoo', address: 'Msimbazi Street', isDefault: false },
    ]);
    expect(created).not.toHaveProperty('createdBy');

    const row = await db('customers').where({ id: created.id }).first();
    expect(row.created_by).toBe(staffId);
  });

  test('creates a company; the full name is not kept for companies', async () => {
    const res = await post({
      type: 'company',
      fullName: 'Not kept',
      companyName: 'Bugando Medical Centre',
      contactPerson: 'Dr. Neema Kweka',
      tin: '123 456 789',
      phone: '+254 711 000 111',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.customer).toMatchObject({
      type: 'company',
      fullName: null,
      companyName: 'Bugando Medical Centre',
      contactPerson: 'Dr. Neema Kweka',
      tin: '123456789',
      phone: '+254711000111',
      email: null,
      addresses: [],
    });
  });

  test('invalid input gives field errors and stores nothing', async () => {
    const res = await post({
      type: 'company',
      companyName: 'X',
      tin: 'ABC',
      phone: '12345',
      email: 'not-an-email',
      notes: 'x'.repeat(2001),
      addresses: [{ area: 'Mwanza', address: '' }, { area: 'A', address: 'Plot 1', label: 'y'.repeat(51) }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual({
      companyName: 'Enter the company name (2 to 150 characters).',
      tin: 'Use digits and dashes only, for example 123-456-789.',
      phone: 'Enter a phone number, for example 0712 345 678 or +254 711 000 111.',
      email: 'Enter a valid email address.',
      notes: 'Use at most 2000 characters.',
      'addresses.0.address': 'Enter a street or landmark (2 to 200 characters).',
      'addresses.1.area': 'Enter the area or city (2 to 100 characters).',
      'addresses.1.label': 'Use at most 50 characters.',
    });

    const noType = await post({ fullName: 'Asha Mushi' });
    expect(noType.body.error.details).toEqual({ type: 'Choose individual or company.' });
    const noName = await post({ type: 'individual' });
    expect(noName.body.error.details).toEqual({ fullName: 'Enter the full name (2 to 100 characters).' });
    const twoDefaults = await post({
      type: 'individual',
      fullName: 'Asha Mushi',
      addresses: [
        { area: 'Mwanza', address: 'Plot 1', isDefault: true },
        { area: 'Arusha', address: 'Plot 2', isDefault: true },
      ],
    });
    expect(twoDefaults.body.error.details).toEqual({ addresses: 'Only one address can be the default.' });

    expect(await db('customers').count('* as n').first()).toEqual({ n: '0' });
  });

  test('duplicate phone or email is allowed (the form only warns)', async () => {
    await customer({ phone: '+255712345678', email: 'asha@example.com' });
    const res = await post({ type: 'individual', fullName: 'Asha M.', phone: '0712345678', email: 'ASHA@example.com' });
    expect(res.status).toBe(201);
  });

  test('GET /:id returns notes and addresses; unknown or malformed ids are 404', async () => {
    const { body } = await post({
      type: 'individual',
      fullName: 'Juma Said',
      notes: 'Walk-in.',
      addresses: [
        { area: 'Arusha', address: 'Plot 2' },
        { area: 'Mwanza', address: 'Plot 1', isDefault: true },
      ],
    });
    const res = await get(body.data.customer.id);
    expect(res.status).toBe(200);
    expect(res.body.data.customer).toMatchObject({ fullName: 'Juma Said', notes: 'Walk-in.' });
    // The default address comes first.
    expect(res.body.data.customer.addresses.map((a) => [a.area, a.isDefault])).toEqual([
      ['Mwanza', true],
      ['Arusha', false],
    ]);

    expect((await get('00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
  });

  test('PATCH changes only what is sent and keeps addresses unless they are sent', async () => {
    const { body } = await post({
      type: 'individual',
      fullName: 'Asha Mushi',
      phone: '0712345678',
      addresses: [{ area: 'Mwanza', address: 'Plot 1' }],
    });
    const { id, updatedAt } = body.data.customer;

    const res = await patch(id, { email: 'asha@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data.customer).toMatchObject({
      fullName: 'Asha Mushi',
      phone: '+255712345678',
      email: 'asha@example.com',
    });
    expect(res.body.data.customer.addresses).toHaveLength(1);
    expect(new Date(res.body.data.customer.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(updatedAt).getTime());

    const cleared = await patch(id, { phone: '', addresses: [] });
    expect(cleared.body.data.customer).toMatchObject({ phone: null, addresses: [] });
  });

  test('switching type keeps only the fields that type allows', async () => {
    const { body } = await post({ type: 'company', companyName: 'Kilimanjaro Clinic', tin: '100-200-300' });
    const { id } = body.data.customer;

    const missingName = await patch(id, { type: 'individual' });
    expect(missingName.status).toBe(400);
    expect(missingName.body.error.details).toEqual({ fullName: 'Enter the full name (2 to 100 characters).' });

    const res = await patch(id, { type: 'individual', fullName: 'Grace Mollel' });
    expect(res.status).toBe(200);
    expect(res.body.data.customer).toMatchObject({
      type: 'individual',
      fullName: 'Grace Mollel',
      companyName: null,
      tin: null,
      contactPerson: null,
    });
  });

  test('PATCH of a missing customer is 404', async () => {
    expect((await patch('00000000-0000-0000-0000-000000000000', { fullName: 'X Y' })).status).toBe(404);
    expect((await patch('nope', { fullName: 'X Y' })).status).toBe(404);
  });

  describe('GET /duplicates', () => {
    const duplicates = (query) => get(`duplicates${query}`);

    test('finds customers by the stored phone or email form and says which matched', async () => {
      const asha = await customer({ phone: '+255712345678', email: 'asha@example.com' });
      const company = await customer({
        type: 'company',
        full_name: null,
        company_name: 'Bugando Medical Centre',
        email: 'asha@example.com',
        created_at: new Date(Date.UTC(2020, 0, 1)),
      });
      await customer({ full_name: 'Other', phone: '+255754100200' });

      const res = await duplicates('?phone=0712%20345%20678&email=ASHA@Example.com');
      expect(res.status).toBe(200);
      expect(res.body.data.matches.map((m) => [m.id, m.matchedOn])).toEqual([
        [asha.id, ['phone', 'email']],
        [company.id, ['email']],
      ]);
      expect(res.body.data.matches[0]).not.toHaveProperty('notes');

      const phoneOnly = await duplicates('?phone=%2B255712345678');
      expect(phoneOnly.body.data.matches.map((m) => m.id)).toEqual([asha.id]);
    });

    test('leaves out the customer being edited', async () => {
      const asha = await customer({ phone: '+255712345678' });
      const res = await duplicates(`?phone=0712345678&exclude=${asha.id}`);
      expect(res.body.data.matches).toEqual([]);
    });

    test('ignores an invalid phone or email and returns nothing for no input', async () => {
      await customer({ phone: '+255712345678', email: 'asha@example.com' });
      expect((await duplicates('?phone=071&email=asha@')).body.data.matches).toEqual([]);
      expect((await duplicates('')).body.data.matches).toEqual([]);
    });

    test('needs a session', async () => {
      expect((await request(app).get('/api/office/customers/duplicates?phone=0712345678')).status).toBe(401);
    });
  });
});

describe('create_customers migration', () => {
  test('migrates down and up again', async () => {
    const tables = async () =>
      (await db('information_schema.tables').whereIn('table_name', ['customers', 'customer_addresses']).pluck('table_name')).sort();

    const [, pending] = await db.migrate.list();
    expect(pending).toEqual([]);

    await db.migrate.down({ name: MIGRATION });
    expect(await tables()).toEqual([]);

    await db.migrate.latest();
    expect(await tables()).toEqual(['customer_addresses', 'customers']);
  });
});
