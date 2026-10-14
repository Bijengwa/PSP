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
