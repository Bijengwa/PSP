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

module.exports = {
  CUSTOMER_TYPES,
  CUSTOMER_PAGE_SIZE,
  listCustomers,
  phoneDigits,
};
