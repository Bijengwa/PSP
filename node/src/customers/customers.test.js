const db = require('../db');

const MIGRATION = '20261014200000_create_customers.js';

let staffId;

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
