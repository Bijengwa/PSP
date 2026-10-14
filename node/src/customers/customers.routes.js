const express = require('express');
const { httpError, requireSameOrigin, requireAuth } = require('../auth/auth.middleware');
const {
  CUSTOMER_TYPES,
  CUSTOMER_PAGE_SIZE,
  listCustomers,
  findCustomer,
  createCustomer,
  updateCustomer,
  findDuplicates,
} = require('./customers.service');

// Office customer directory, mounted at /api/office/customers. Any signed-in staff
// member may use it until the permissions stage (H3-H5) replaces role checks.
const router = express.Router();
router.use(requireSameOrigin, requireAuth());

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Tanzanian numbers, as the shop checkout reads them: 9 digits after +255 or a leading 0.
const TZ_PHONE_PATTERN = /^(?:\+?255|0)?([267]\d{8})$/;
// Any other country: + (or 00) and 8 to 15 digits.
const INTL_PHONE_PATTERN = /^(?:\+|00)([1-9]\d{7,14})$/;
const TIN_PATTERN = /^\d[\d-]*$/;
const MAX_ADDRESSES = 10;

const text = (raw) => (typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '');

// "0712 345 678" -> "+255712345678" (the form orders use), "+254 711 000 111" ->
// "+254711000111". Returns null for anything else.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const compact = raw.replace(/[\s().-]/g, '');
  const tz = compact.match(TZ_PHONE_PATTERN);
  if (tz) return `+255${tz[1]}`;
  const intl = compact.match(INTL_PHONE_PATTERN);
  return intl ? `+${intl[1]}` : null;
}

function normalizeEmail(raw) {
  const email = text(raw).toLowerCase();
  return email && email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

function validationError(fields) {
  return Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: fields });
}

function parseAddresses(raw, fields) {
  if (!Array.isArray(raw)) {
    fields.addresses = 'Addresses must be a list.';
    return null;
  }
  const rows = [];
  raw.forEach((row, index) => {
    const label = text(row?.label);
    const area = text(row?.area);
    const address = text(row?.address);
    if (!label && !area && !address) return; // blank rows are dropped
    const key = `addresses.${index}`;
    if (label.length > 50) fields[`${key}.label`] = 'Use at most 50 characters.';
    if (area.length < 2 || area.length > 100) fields[`${key}.area`] = 'Enter the area or city (2 to 100 characters).';
    if (address.length < 2 || address.length > 200) {
      fields[`${key}.address`] = 'Enter a street or landmark (2 to 200 characters).';
    }
    rows.push({ label, area, address, isDefault: row?.isDefault === true });
  });
  if (rows.length > MAX_ADDRESSES) fields.addresses = `Use at most ${MAX_ADDRESSES} addresses.`;
  else if (rows.filter((row) => row.isDefault).length > 1) fields.addresses = 'Only one address can be the default.';
  // With addresses but no default, the first one is the default.
  if (rows.length > 0 && !rows.some((row) => row.isDefault)) rows[0].isDefault = true;
  return rows;
}

// Validates a whole customer: the body's fields over `current` (PATCH) or over nothing
// (POST). Company fields are kept only for companies and the full name only for
// individuals, as the table requires. Returns { fields } or { values, addresses }.
function parseCustomer(body, current = null) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const pick = (key) => (has(key) ? input[key] : (current?.[key] ?? ''));
  const fields = {};

  const type = pick('type');
  if (!CUSTOMER_TYPES.includes(type)) fields.type = 'Choose individual or company.';
  const company = type === 'company';

  const values = {
    type,
    fullName: null,
    companyName: null,
    tin: null,
    contactPerson: null,
    phone: null,
    email: null,
    notes: '',
  };

  if (type === 'individual') {
    const fullName = text(pick('fullName'));
    if (fullName.length < 2 || fullName.length > 100) fields.fullName = 'Enter the full name (2 to 100 characters).';
    else values.fullName = fullName;
  }

  if (company) {
    const companyName = text(pick('companyName'));
    if (companyName.length < 2 || companyName.length > 150) {
      fields.companyName = 'Enter the company name (2 to 150 characters).';
    } else values.companyName = companyName;

    const contactPerson = text(pick('contactPerson'));
    if (contactPerson.length > 100) fields.contactPerson = 'Use at most 100 characters.';
    else values.contactPerson = contactPerson || null;

    const tin = text(pick('tin')).replace(/\s/g, '');
    if (tin && (tin.length > 20 || !TIN_PATTERN.test(tin))) {
      fields.tin = 'Use digits and dashes only, for example 123-456-789.';
    } else values.tin = tin || null;
  }

  const rawPhone = text(pick('phone'));
  if (rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!phone) fields.phone = 'Enter a phone number, for example 0712 345 678 or +254 711 000 111.';
    else values.phone = phone;
  }

  const rawEmail = text(pick('email'));
  if (rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!email) fields.email = 'Enter a valid email address.';
    else values.email = email;
  }

  const notes = pick('notes');
  if (typeof notes !== 'string') fields.notes = 'Notes must be text.';
  else if (notes.trim().length > 2000) fields.notes = 'Use at most 2000 characters.';
  else values.notes = notes.trim();

  const addresses = has('addresses') ? parseAddresses(input.addresses, fields) : undefined;

  return Object.keys(fields).length ? { fields } : { values, addresses };
}

router.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const type = req.query.type || undefined;
  if (type && !CUSTOMER_TYPES.includes(type)) {
    throw httpError(400, `type must be one of: ${CUSTOMER_TYPES.join(', ')}`);
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  res.json({ success: true, data: await listCustomers({ q, type, page, limit: CUSTOMER_PAGE_SIZE }) });
});

// Who already has this phone or email? For the form's duplicate warning only; a
// duplicate never blocks saving. Values that are not a valid phone or email are ignored.
router.get('/duplicates', async (req, res) => {
  const phone = typeof req.query.phone === 'string' ? normalizePhone(req.query.phone) : null;
  const email = typeof req.query.email === 'string' ? normalizeEmail(req.query.email) : null;
  const exclude = typeof req.query.exclude === 'string' && UUID_PATTERN.test(req.query.exclude) ? req.query.exclude : null;

  res.json({ success: true, data: { matches: await findDuplicates({ phone, email, excludeId: exclude }) } });
});

router.post('/', async (req, res) => {
  const parsed = parseCustomer(req.body);
  if (parsed.fields) throw validationError(parsed.fields);

  const customer = await createCustomer({
    values: parsed.values,
    addresses: parsed.addresses ?? [],
    createdBy: req.staff.id,
  });

  req.log.info({ event: 'customer.created', customerId: customer.id, by: req.staff.id }, 'Customer created');
  res.status(201).json({ success: true, data: { customer } });
});

function idParam(req) {
  if (!UUID_PATTERN.test(req.params.id)) throw httpError(404, 'Not found');
  return req.params.id;
}

router.get('/:id', async (req, res) => {
  const customer = await findCustomer(idParam(req));
  if (!customer) throw httpError(404, 'Not found');
  res.json({ success: true, data: { customer } });
});

router.patch('/:id', async (req, res) => {
  const id = idParam(req);
  const current = await findCustomer(id);
  if (!current) throw httpError(404, 'Not found');

  const parsed = parseCustomer(req.body, current);
  if (parsed.fields) throw validationError(parsed.fields);

  const customer = await updateCustomer(id, parsed.values, parsed.addresses);
  if (!customer) throw httpError(404, 'Not found');

  req.log.info({ event: 'customer.updated', customerId: id, by: req.staff.id }, 'Customer updated');
  res.json({ success: true, data: { customer } });
});

module.exports = router;
