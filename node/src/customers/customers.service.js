const db = require('../db');

const CUSTOMER_TYPES = ['individual', 'company'];
const CUSTOMER_PAGE_SIZE = 25;

const CUSTOMER_COLUMNS = [
  'id',
  'type',
  'full_name',
  'company_name',
  'tin',
  'contact_person',
  'phone',
  'email',
  'created_at',
  'updated_at',
];

function toPublicCustomer(row) {
  return {
    id: row.id,
    type: row.type,
    fullName: row.full_name,
    companyName: row.company_name,
    tin: row.tin,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

// Phones are stored as "+255712345678". A search typed as "0712 345" or "+255 712"
// becomes the digits to look for in that form ("255712345", "255712").
// Returns null when the search is not a phone number.
function phoneDigits(q) {
  if (!/^[\d\s()+-]+$/.test(q)) return null;
  const digits = q.replace(/\D/g, '');
  if (digits.length < 3) return null;
  return digits.startsWith('0') ? `255${digits.slice(1)}` : digits;
}

// Search by name, company, contact person, phone or email, filter by type, paged,
// newest first. `total` counts every match; `counts` is how many each type tab would
// show with the same search.
async function listCustomers({ q, type, page = 1, limit = CUSTOMER_PAGE_SIZE }) {
  const filters = (query, { withType = true } = {}) => {
    if (q) {
      const like = `%${escapeLike(q)}%`;
      const digits = phoneDigits(q);
      query.where((b) => {
        b.whereILike('full_name', like)
          .orWhereILike('company_name', like)
          .orWhereILike('contact_person', like)
          .orWhereILike('email', like)
          .orWhereILike('phone', like);
        if (digits) b.orWhereLike('phone', `%${digits}%`);
      });
    }
    if (withType && type) query.where({ type });
    return query;
  };

  const [rows, [{ count }], [counts]] = await Promise.all([
    filters(db('customers'))
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id' }])
      .limit(limit)
      .offset((page - 1) * limit)
      .select(CUSTOMER_COLUMNS),
    filters(db('customers')).count('* as count'),
    filters(db('customers'), { withType: false }).select(
      db.raw('count(*) as all_count'),
      db.raw("count(*) filter (where type = 'individual') as individual"),
      db.raw("count(*) filter (where type = 'company') as company"),
    ),
  ]);

  return {
    total: Number(count),
    page,
    pageSize: limit,
    counts: {
      all: Number(counts.all_count),
      individual: Number(counts.individual),
      company: Number(counts.company),
    },
    customers: rows.map(toPublicCustomer),
  };
}

const ADDRESS_COLUMNS = ['id', 'label', 'area', 'address', 'is_default'];

function toAddress(row) {
  return { id: row.id, label: row.label, area: row.area, address: row.address, isDefault: row.is_default };
}

// One customer with notes and addresses (default first), or null.
async function findCustomer(id, trx = db) {
  const row = await trx('customers').where({ id }).first([...CUSTOMER_COLUMNS, 'notes']);
  if (!row) return null;
  const addresses = await trx('customer_addresses')
    .where({ customer_id: id })
    .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'created_at' }, { column: 'id' }])
    .select(ADDRESS_COLUMNS);
  return { ...toPublicCustomer(row), notes: row.notes, addresses: addresses.map(toAddress) };
}

function toRow(values) {
  return {
    type: values.type,
    full_name: values.fullName,
    company_name: values.companyName,
    tin: values.tin,
    contact_person: values.contactPerson,
    phone: values.phone,
    email: values.email,
    notes: values.notes,
  };
}

// Replaces the customer's addresses with `addresses` (already validated, at most one default).
async function replaceAddresses(trx, customerId, addresses) {
  await trx('customer_addresses').where({ customer_id: customerId }).del();
  if (addresses.length === 0) return;
  await trx('customer_addresses').insert(
    addresses.map((a) => ({
      customer_id: customerId,
      label: a.label,
      area: a.area,
      address: a.address,
      is_default: a.isDefault,
    })),
  );
}

// Runs in its own transaction, or in `outer` when the caller has one (an order being
// linked to the new customer, M7.5).
async function createCustomer({ values, addresses, createdBy }, outer = null) {
  const create = async (trx) => {
    const [{ id }] = await trx('customers')
      .insert({ ...toRow(values), created_by: createdBy })
      .returning('id');
    await replaceAddresses(trx, id, addresses);
    return findCustomer(id, trx);
  };
  return outer ? create(outer) : db.transaction(create);
}

// `addresses` undefined leaves them as they are. Returns null when the customer is gone.
async function updateCustomer(id, values, addresses) {
  return db.transaction(async (trx) => {
    const updated = await trx('customers')
      .where({ id })
      .update({ ...toRow(values), updated_at: trx.fn.now() });
    if (!updated) return null;
    if (addresses) await replaceAddresses(trx, id, addresses);
    return findCustomer(id, trx);
  });
}

// Customers who already have this phone or email (stored forms), newest first, for the
// form's duplicate warning. Duplicates are allowed; this only tells staff about them.
async function findDuplicates({ phone, email, excludeId, limit = 5 }) {
  if (!phone && !email) return [];
  const query = db('customers').where((b) => {
    if (phone) b.orWhere({ phone });
    if (email) b.orWhere({ email });
  });
  if (excludeId) query.whereNot({ id: excludeId });
  const rows = await query
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id' }])
    .limit(limit)
    .select(CUSTOMER_COLUMNS);
  return rows.map((row) => ({
    ...toPublicCustomer(row),
    matchedOn: [...(phone && row.phone === phone ? ['phone'] : []), ...(email && row.email === email ? ['email'] : [])],
  }));
}

module.exports = {
  CUSTOMER_TYPES,
  CUSTOMER_PAGE_SIZE,
  listCustomers,
  phoneDigits,
  findCustomer,
  createCustomer,
  updateCustomer,
  findDuplicates,
};
