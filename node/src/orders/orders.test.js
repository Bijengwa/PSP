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
const { grantMatrix } = require('../auth/permissions.testing');
const { app } = require('../server');
const sessions = require('../auth/session.store');
const {
  ORDER_STATUSES,
  STATUS_TRANSITIONS,
  CANCEL_REASON_MAX,
  canChangeStatus,
  changeOrderStatus,
  markOrderPaid,
} = require('./orders.service');

const MIGRATION = '20261014220000_extend_orders.js';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let staffId;

// Inserts a shop order straight into the table, `new` and unpaid by default.
async function order(over = {}) {
  const [row] = await db('orders')
    .insert({
      guest_name: 'Asha Mushi',
      guest_phone: '+255712345678',
      delivery_area: 'Kariakoo',
      delivery_address: 'Msimbazi Street',
      source: 'shop',
      total_tzs: 1000000,
      ...over,
    })
    .returning('*');
  return row;
}

// Puts an order straight into `status`, with the columns that status needs.
const inStatus = (status) =>
  order({
    status,
    ...(status === 'cancelled' ? { cancel_reason: 'Customer changed their mind', cancelled_at: db.fn.now() } : {}),
  });

// Resolves to the Postgres error code of a failed query, or null if it worked.
const failure = (promise) => promise.then(
  () => null,
  (err) => err.code,
);

beforeAll(async () => {
  await db.migrate.latest();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  const [role] = await db('roles').insert({ name: 'staff', description: 'Staff' }).returning('id');
  await grantMatrix();
  const [staff] = await db('staff_profiles')
    .insert({ full_name: 'Sam Staff', email: 's@psp.test', password_hash: 'x', role_id: role.id, must_change_password: false })
    .returning('id');
  staffId = staff.id;
});

beforeEach(async () => {
  await db('order_items').del();
  await db('orders').del();
  await db('customer_addresses').del();
  await db('customers').del();
});

afterAll(async () => {
  await db('order_items').del();
  await db('orders').del();
  await db('customer_addresses').del();
  await db('customers').del();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  await db.destroy();
});

describe('order life cycle rules', () => {
  test('allow only new → confirmed → delivered → closed, and cancel from new or confirmed', () => {
    expect(STATUS_TRANSITIONS).toEqual({
      new: ['confirmed', 'cancelled'],
      confirmed: ['delivered', 'cancelled'],
      delivered: ['closed'],
      closed: [],
      cancelled: [],
    });
    expect(canChangeStatus('new', 'delivered')).toBe(false);
    expect(canChangeStatus('closed', 'new')).toBe(false);
    expect(canChangeStatus('unknown', 'confirmed')).toBe(false);
  });
});

describe('changeOrderStatus', () => {
  const pairs = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.filter((to) => to !== 'new').map((to) => [from, to]));
  const allowed = pairs.filter(([from, to]) => canChangeStatus(from, to));
  const refused = pairs.filter(([from, to]) => !canChangeStatus(from, to));

  test.each(allowed)('moves %s → %s and stamps the time', async (from, to) => {
    const before = await inStatus(from);
    const result = await changeOrderStatus(before.id, to, { reason: 'Out of stock at the supplier' });

    expect(result.order.status).toBe(to);
    expect(result.order[`${to}_at`]).toBeInstanceOf(Date);
    expect(result.order.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
  });

  test.each(refused)('refuses %s → %s and leaves the order unchanged', async (from, to) => {
    const before = await inStatus(from);
    const result = await changeOrderStatus(before.id, to, { reason: 'Any reason' });

    expect(result).toEqual({ error: 'invalid_transition', from });
    const after = await db('orders').where({ id: before.id }).first();
    expect(after).toEqual(before);
  });

  test('refuses moving back to new or to an unknown status', async () => {
    const { id } = await inStatus('confirmed');
    expect(await changeOrderStatus(id, 'new')).toEqual({ error: 'invalid_status' });
    expect(await changeOrderStatus(id, 'shipped')).toEqual({ error: 'invalid_status' });
    expect(await changeOrderStatus(id, undefined)).toEqual({ error: 'invalid_status' });
    expect((await db('orders').where({ id }).first()).status).toBe('confirmed');
  });

  test('cancelling needs a reason, stored trimmed', async () => {
    const { id } = await order();
    for (const reason of [undefined, '', '   ', 42, 'x'.repeat(CANCEL_REASON_MAX + 1)]) {
      expect(await changeOrderStatus(id, 'cancelled', { reason })).toEqual({ error: 'reason_required' });
    }
    expect((await db('orders').where({ id }).first()).status).toBe('new');

    const { order: cancelled } = await changeOrderStatus(id, 'cancelled', { reason: '  Customer changed their mind  ' });
    expect(cancelled.cancel_reason).toBe('Customer changed their mind');
    expect(cancelled.cancelled_at).toBeInstanceOf(Date);
  });

  test('a reason is not stored for other statuses', async () => {
    const { id } = await order();
    const { order: confirmed } = await changeOrderStatus(id, 'confirmed', { reason: 'ignored' });
    expect(confirmed.cancel_reason).toBeNull();
  });

  test('returns null for an order that does not exist', async () => {
    expect(await changeOrderStatus(MISSING_ID, 'confirmed')).toBeNull();
  });

  test('two staff confirming at once: only one wins', async () => {
    const { id } = await order();
    const results = await Promise.all([changeOrderStatus(id, 'confirmed'), changeOrderStatus(id, 'confirmed')]);

    expect(results.filter((r) => r.order)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toEqual([{ error: 'invalid_transition', from: 'confirmed' }]);
  });

  test('a full life cycle ends closed and stays closed', async () => {
    const { id } = await order();
    for (const to of ['confirmed', 'delivered', 'closed']) {
      expect((await changeOrderStatus(id, to)).order.status).toBe(to);
    }
    const row = await db('orders').where({ id }).first();
    expect([row.confirmed_at, row.delivered_at, row.closed_at].every((t) => t instanceof Date)).toBe(true);
    expect(await changeOrderStatus(id, 'cancelled', { reason: 'Too late' })).toEqual({
      error: 'invalid_transition',
      from: 'closed',
    });
  });
});

describe('markOrderPaid', () => {
  test('moves unpaid to paid and stamps the time', async () => {
    const { id } = await order();
    const { order: paid } = await markOrderPaid(id);
    expect(paid.payment_status).toBe('paid');
    expect(paid.paid_at).toBeInstanceOf(Date);
    expect(paid.status).toBe('new');
  });

  test('works in every status except cancelled', async () => {
    for (const status of ['confirmed', 'delivered', 'closed']) {
      const { id } = await inStatus(status);
      expect((await markOrderPaid(id)).order.payment_status).toBe('paid');
    }
    const { id } = await inStatus('cancelled');
    expect(await markOrderPaid(id)).toEqual({ error: 'cancelled' });
    expect((await db('orders').where({ id }).first()).payment_status).toBe('unpaid');
  });

  test('refuses paying twice and never goes back to unpaid', async () => {
    const { id } = await order();
    const { order: first } = await markOrderPaid(id);
    expect(await markOrderPaid(id)).toEqual({ error: 'already_paid' });
    expect((await db('orders').where({ id }).first()).paid_at).toEqual(first.paid_at);
  });

  test('returns null for an order that does not exist', async () => {
    expect(await markOrderPaid(MISSING_ID)).toBeNull();
  });
});

describe('orders table (M7.1 columns)', () => {
  test('a staff order names who entered it; a shop order names nobody', async () => {
    expect(await failure(order({ source: 'staff' }))).toBe('23514');
    expect(await failure(order({ source: 'shop', created_by: staffId }))).toBe('23514');
    expect(await failure(order({ source: 'staff', created_by: staffId }))).toBeNull();
    expect(await failure(order({ source: 'staff', created_by: MISSING_ID }))).toBe('23503');
  });

  test('a cancelled order has a reason and a time, and only a cancelled order has a reason', async () => {
    expect(await failure(order({ status: 'cancelled' }))).toBe('23514');
    expect(await failure(order({ status: 'cancelled', cancel_reason: 'x' }))).toBe('23514');
    expect(await failure(order({ cancel_reason: 'x', cancelled_at: db.fn.now() }))).toBe('23514');
  });

  test('a paid order has a paid time, and an unpaid one has none', async () => {
    expect(await failure(order({ payment_status: 'paid' }))).toBe('23514');
    expect(await failure(order({ paid_at: db.fn.now() }))).toBe('23514');
    expect(await failure(order({ payment_status: 'paid', paid_at: db.fn.now() }))).toBeNull();
  });

  test('customer_id must point at a customer, and the order survives the customer', async () => {
    expect(await failure(order({ customer_id: MISSING_ID }))).toBe('23503');

    const [customer] = await db('customers')
      .insert({ type: 'individual', full_name: 'Asha Mushi', created_by: staffId })
      .returning('id');
    const { id } = await order({ customer_id: customer.id });
    await db('customers').where({ id: customer.id }).del();

    const row = await db('orders').where({ id }).first();
    expect(row.customer_id).toBeNull();
    expect(row.guest_name).toBe('Asha Mushi');
  });
});

describe('orders queue (GET /api/office/orders)', () => {
  let staffCookie;
  let productId;

  beforeAll(async () => {
    staffCookie = `psp_sid=${(await sessions.create({ staffId, ip: '::1', userAgent: 't' })).id}`;
    const [row] = await db('products')
      .insert({
        name: 'Queue test monitor',
        slug: 'queue-test-monitor',
        sku: 'QUEUE-TEST-1',
        category_id: 1,
        price_tzs: 1000000,
        is_published: true,
        created_by: staffId,
      })
      .returning('id');
    productId = row.id;
  });

  afterAll(async () => {
    await db('order_items').del();
    await db('products').where({ id: productId }).del();
  });

  const list = (query = '') => request(app).get(`/api/office/orders${query}`).set('Cookie', staffCookie);
  const names = (res) => res.body.data.orders.map((o) => o.guestName);

  // Five orders, oldest first: two new (one staff), one confirmed and paid, one delivered, one cancelled.
  async function seed() {
    const rows = [
      { guest_name: 'Asha Mushi', guest_phone: '+255712345678' },
      { guest_name: 'Juma Said', guest_phone: '+255754100200', status: 'confirmed', payment_status: 'paid', paid_at: db.fn.now() },
      { guest_name: '50% Discount Person', guest_phone: '+255688000111', status: 'delivered' },
      { guest_name: 'Neema Kweka', guest_phone: '+255713222333', source: 'staff', created_by: staffId },
      {
        guest_name: 'Grace Mollel',
        guest_phone: '+254711000111',
        status: 'cancelled',
        cancel_reason: 'Ordered twice',
        cancelled_at: db.fn.now(),
      },
    ];
    const made = [];
    for (const [n, row] of rows.entries()) {
      made.push(await order({ ...row, created_at: new Date(Date.UTC(2026, 9, 1 + n)) }));
    }
    return made;
  }

  test('requires a session', async () => {
    const res = await request(app).get('/api/office/orders');
    expect(res.status).toBe(401);
  });

  test('a normal staff member can use it; empty queue with zero counts', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      orders: [],
      total: 0,
      page: 1,
      pageSize: 25,
      counts: { all: 0, new: 0, confirmed: 0, delivered: 0, closed: 0, cancelled: 0 },
    });
  });

  test('lists newest first in the queue shape, with the item count and total as numbers', async () => {
    const [asha] = await seed();
    await db('orders').where({ id: asha.id }).update({ notes: 'Call before delivery', has_quotation_lines: true });
    await db('order_items').insert([
      { order_id: asha.id, product_id: productId, product_name: 'Monitor', product_sku: 'M-1', unit_price_tzs: 500000, quantity: 2, line_total_tzs: 1000000 },
      { order_id: asha.id, product_id: productId, product_name: 'CT scanner', product_sku: 'CT-1', quantity: 1, sort_order: 1 },
    ]);

    const res = await list();
    expect(names(res)).toEqual(['Grace Mollel', 'Neema Kweka', '50% Discount Person', 'Juma Said', 'Asha Mushi']);
    expect(res.body.data.counts).toEqual({ all: 5, new: 2, confirmed: 1, delivered: 1, closed: 0, cancelled: 1 });

    const row = res.body.data.orders[4];
    expect(Object.keys(row).sort()).toEqual([
      'createdAt',
      'customerId',
      'deliveryArea',
      'guestName',
      'guestPhone',
      'hasQuotationLines',
      'id',
      'itemCount',
      'orderNumber',
      'paymentStatus',
      'source',
      'status',
      'totalTzs',
    ]);
    expect(row).toMatchObject({
      id: asha.id,
      orderNumber: asha.order_number,
      status: 'new',
      paymentStatus: 'unpaid',
      source: 'shop',
      customerId: null,
      guestName: 'Asha Mushi',
      guestPhone: '+255712345678',
      deliveryArea: 'Kariakoo',
      totalTzs: 1000000,
      hasQuotationLines: true,
      itemCount: 3,
    });
    expect(res.body.data.orders[0].itemCount).toBe(0);
  });

  test('search by order number, name and phone (any case, local phone form)', async () => {
    const made = await seed();
    const juma = made[1];
    expect(names(await list(`?q=${juma.order_number}`))).toEqual(['Juma Said']);
    expect(names(await list(`?q=${juma.order_number.slice(-6).toLowerCase()}`))).toEqual(['Juma Said']);
    expect(names(await list(`?q=${juma.order_number.toLowerCase()}`))).toEqual(['Juma Said']);
    expect(names(await list('?q=ASHA'))).toEqual(['Asha Mushi']);
    expect(names(await list(`?q=${encodeURIComponent('0754 100 200')}`))).toEqual(['Juma Said']);
    expect(names(await list('?q=%2B254711'))).toEqual(['Grace Mollel']);
    expect(names(await list('?q=50%25'))).toEqual(['50% Discount Person']);
    expect((await list('?q=_')).body.data.total).toBe(0);
    expect((await list('?q=nobody')).body.data.total).toBe(0);
  });

  test('filters by status, payment status and source; counts follow everything but the status', async () => {
    await seed();
    let res = await list('?status=new');
    expect(names(res)).toEqual(['Neema Kweka', 'Asha Mushi']);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.counts).toEqual({ all: 5, new: 2, confirmed: 1, delivered: 1, closed: 0, cancelled: 1 });

    res = await list('?paymentStatus=paid');
    expect(names(res)).toEqual(['Juma Said']);
    expect(res.body.data.counts).toEqual({ all: 1, new: 0, confirmed: 1, delivered: 0, closed: 0, cancelled: 0 });

    res = await list('?source=staff');
    expect(names(res)).toEqual(['Neema Kweka']);

    res = await list('?status=new&source=shop&paymentStatus=unpaid');
    expect(names(res)).toEqual(['Asha Mushi']);
    expect(res.body.data.counts).toMatchObject({ all: 3, new: 1, delivered: 1, cancelled: 1 });

    res = await list('?status=closed&q=asha');
    expect(res.body.data).toMatchObject({ orders: [], total: 0, counts: { all: 1, new: 1 } });
  });

  test('unknown filter values are a 400', async () => {
    for (const query of ['?status=shipped', '?paymentStatus=partial', '?source=phone', '?status=new&status=closed']) {
      const res = await list(query);
      expect(res.status).toBe(400);
    }
    expect((await list('?status=shipped')).body.error.message).toMatch(/new, confirmed, delivered, closed, cancelled/);
  });

  test('pages of 25; bad page numbers fall back to 1', async () => {
    for (let n = 0; n < 27; n += 1) {
      await order({ guest_name: `Guest ${String(n).padStart(2, '0')}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, n)) });
    }
    const first = await list();
    expect(first.body.data).toMatchObject({ total: 27, page: 1, pageSize: 25 });
    expect(first.body.data.orders).toHaveLength(25);
    expect(first.body.data.orders[0].guestName).toBe('Guest 26');

    const second = await list('?page=2');
    expect(names(second)).toEqual(['Guest 01', 'Guest 00']);
    expect((await list('?page=abc')).body.data.page).toBe(1);
    expect((await list('?page=9')).body.data.orders).toEqual([]);
  });

  test('the sidebar badge count: new orders only', async () => {
    await seed();
    const res = await list('?status=new');
    expect(res.body.data.total).toBe(2);
  });
});

describe('order detail and actions (M7.3)', () => {
  const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  let staffCookie;
  let productId;

  beforeAll(async () => {
    staffCookie = `psp_sid=${(await sessions.create({ staffId, ip: '::1', userAgent: 't' })).id}`;
    const [row] = await db('products')
      .insert({
        name: 'Detail test monitor',
        slug: 'detail-test-monitor',
        sku: 'DETAIL-TEST-1',
        category_id: 1,
        price_tzs: 500000,
        is_published: true,
        created_by: staffId,
      })
      .returning('id');
    productId = row.id;
  });

  afterAll(async () => {
    await db('order_items').del();
    await db('products').where({ id: productId }).del();
  });

  // An order with a priced line (2 × 500,000) and a quotation line, in `status`.
  async function orderWithItems(over = {}) {
    const row = await order({ total_tzs: 1000000, has_quotation_lines: true, ...over });
    const items = await db('order_items')
      .insert([
        {
          order_id: row.id,
          product_id: productId,
          product_name: 'Patient monitor',
          product_sku: 'PM-12',
          unit_price_tzs: 500000,
          quantity: 2,
          line_total_tzs: 1000000,
        },
        { order_id: row.id, product_id: productId, product_name: 'CT scanner', product_sku: 'CT-64', quantity: 1, sort_order: 1 },
      ])
      .returning('*');
    return { row, items };
  }

  const get = (id) => request(app).get(`/api/office/orders/${id}`).set('Cookie', staffCookie);
  const post = (path, body) =>
    request(app).post(`/api/office/orders/${path}`).set('Cookie', staffCookie).set('Origin', ORIGIN).send(body);
  const putItems = (id, items) =>
    request(app).put(`/api/office/orders/${id}/items`).set('Cookie', staffCookie).set('Origin', ORIGIN).send({ items });

  test('need a session, and changes need the office origin', async () => {
    const { row } = await orderWithItems();
    expect((await request(app).get(`/api/office/orders/${row.id}`)).status).toBe(401);
    const noOrigin = await request(app)
      .post(`/api/office/orders/${row.id}/status`)
      .set('Cookie', staffCookie)
      .send({ status: 'confirmed' });
    expect(noOrigin.status).toBe(403);
    expect((await db('orders').where({ id: row.id }).first()).status).toBe('new');
  });

  test('the detail has items, totals, guest details and the next steps', async () => {
    const { row, items } = await orderWithItems({ guest_email: 'asha@example.com', notes: 'Call before delivery' });
    const res = await get(row.id);

    expect(res.status).toBe(200);
    expect(res.body.data.order).toMatchObject({
      id: row.id,
      orderNumber: row.order_number,
      status: 'new',
      paymentStatus: 'unpaid',
      source: 'shop',
      customer: null,
      createdBy: null,
      guestName: 'Asha Mushi',
      guestPhone: '+255712345678',
      guestEmail: 'asha@example.com',
      deliveryArea: 'Kariakoo',
      deliveryAddress: 'Msimbazi Street',
      notes: 'Call before delivery',
      totalTzs: 1000000,
      hasQuotationLines: true,
      cancelReason: null,
      confirmedAt: null,
      paidAt: null,
      nextStatuses: ['confirmed', 'cancelled'],
      itemsEditable: true,
      items: [
        { id: items[0].id, productId, productName: 'Patient monitor', productSku: 'PM-12', unitPriceTzs: 500000, quantity: 2, lineTotalTzs: 1000000 },
        { id: items[1].id, productId, productName: 'CT scanner', productSku: 'CT-64', unitPriceTzs: null, quantity: 1, lineTotalTzs: null },
      ],
    });
  });

  test('the detail names the linked customer and who entered a staff order', async () => {
    const [customer] = await db('customers')
      .insert({ type: 'company', company_name: 'Bugando Medical Centre', created_by: staffId })
      .returning('id');
    const { row } = await orderWithItems({ customer_id: customer.id, source: 'staff', created_by: staffId });
    const { order: detail } = (await get(row.id)).body.data;

    expect(detail.customer).toEqual({ id: customer.id, type: 'company', name: 'Bugando Medical Centre' });
    expect(detail.createdBy).toEqual({ id: staffId, fullName: 'Sam Staff' });
  });

  test('unknown or malformed ids are a 404', async () => {
    expect((await get(MISSING_ID)).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
    expect((await post(`${MISSING_ID}/status`, { status: 'confirmed' })).status).toBe(404);
    expect((await post(`${MISSING_ID}/paid`)).status).toBe(404);
    expect((await putItems(MISSING_ID, [{ id: MISSING_ID, quantity: 1 }])).status).toBe(404);
  });

  test('confirm, deliver and close move the order along and answer with it', async () => {
    const { row } = await orderWithItems();
    const steps = [
      ['confirmed', 'confirmedAt', ['delivered', 'cancelled'], false],
      ['delivered', 'deliveredAt', ['closed'], false],
      ['closed', 'closedAt', [], false],
    ];
    for (const [status, stamp, next, editable] of steps) {
      const res = await post(`${row.id}/status`, { status });
      expect(res.status).toBe(200);
      expect(res.body.data.order).toMatchObject({ status, nextStatuses: next, itemsEditable: editable });
      expect(res.body.data.order[stamp]).toEqual(expect.any(String));
    }
  });

  test('cancel needs a reason, from new or confirmed', async () => {
    const { row } = await orderWithItems();
    for (const reason of [undefined, '', '   ', 'x'.repeat(CANCEL_REASON_MAX + 1)]) {
      const res = await post(`${row.id}/status`, { status: 'cancelled', reason });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual({ reason: expect.stringMatching(/reason/) });
    }

    const res = await post(`${row.id}/status`, { status: 'cancelled', reason: '  Ordered twice ' });
    expect(res.status).toBe(200);
    expect(res.body.data.order).toMatchObject({ status: 'cancelled', cancelReason: 'Ordered twice', nextStatuses: [] });

    const confirmed = await inStatus('confirmed');
    expect((await post(`${confirmed.id}/status`, { status: 'cancelled', reason: 'Out of stock' })).status).toBe(200);
  });

  test('refused moves are a 409 naming the current status; bad statuses a 400', async () => {
    const { row } = await orderWithItems();
    let res = await post(`${row.id}/status`, { status: 'delivered' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'INVALID_TRANSITION', details: { status: 'new' } });

    const delivered = await inStatus('delivered');
    res = await post(`${delivered.id}/status`, { status: 'cancelled', reason: 'Too late' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('This order is delivered, so it cannot be moved to cancelled.');

    for (const status of ['new', 'shipped', undefined]) {
      res = await post(`${row.id}/status`, { status });
      expect(res.status).toBe(400);
    }
    expect((await db('orders').where({ id: row.id }).first()).status).toBe('new');
  });

  test('mark paid works once and never on a cancelled order', async () => {
    const { row } = await orderWithItems();
    const res = await post(`${row.id}/paid`);
    expect(res.status).toBe(200);
    expect(res.body.data.order).toMatchObject({ paymentStatus: 'paid', paidAt: expect.any(String), status: 'new' });

    const again = await post(`${row.id}/paid`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PAID');

    const cancelled = await inStatus('cancelled');
    const refused = await post(`${cancelled.id}/paid`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ORDER_CANCELLED');
    expect((await db('orders').where({ id: cancelled.id }).first()).payment_status).toBe('unpaid');
  });

  test('a new order: quantities change and lines drop; totals use the copied prices', async () => {
    const { row, items } = await orderWithItems();
    // A later price change on the product must not reach the order.
    await db('products').where({ id: productId }).update({ price_tzs: 999999 });

    let res = await putItems(row.id, [
      { id: items[0].id, quantity: 3 },
      { id: items[1].id, quantity: 2 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.order).toMatchObject({ totalTzs: 1500000, hasQuotationLines: true });
    expect(res.body.data.order.items.map((i) => [i.quantity, i.unitPriceTzs, i.lineTotalTzs])).toEqual([
      [3, 500000, 1500000],
      [2, null, null],
    ]);

    res = await putItems(row.id, [{ id: items[0].id, quantity: 1 }]);
    expect(res.body.data.order).toMatchObject({ totalTzs: 500000, hasQuotationLines: false });
    expect(res.body.data.order.items).toHaveLength(1);
    expect(await db('order_items').where({ id: items[1].id }).first()).toBeUndefined();
    await db('products').where({ id: productId }).update({ price_tzs: 500000 });
  });

  test('item changes are checked: at least one line, own lines only, quantity 1 to 99', async () => {
    const { row, items } = await orderWithItems();
    const other = await orderWithItems();
    const cases = [
      [],
      [{ id: items[0].id, quantity: 0 }],
      [{ id: items[0].id, quantity: 100 }],
      [{ id: items[0].id, quantity: 1.5 }],
      [{ id: items[0].id, quantity: '2' }],
      [{ id: 'nope', quantity: 1 }],
      [
        { id: items[0].id, quantity: 1 },
        { id: items[0].id, quantity: 2 },
      ],
      [{ id: other.items[0].id, quantity: 1 }],
    ];
    for (const body of cases) {
      const res = await putItems(row.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await putItems(row.id, 'not a list')).status).toBe(400);
    expect(await db('order_items').where({ order_id: row.id }).orderBy('sort_order').pluck('quantity')).toEqual([2, 1]);
  });

  test.each(['confirmed', 'delivered', 'closed', 'cancelled'])(
    'items cannot change once the order is %s',
    async (status) => {
      const { row, items } = await orderWithItems({
        status,
        ...(status === 'cancelled' ? { cancel_reason: 'Ordered twice', cancelled_at: db.fn.now() } : {}),
      });
      const res = await putItems(row.id, [{ id: items[0].id, quantity: 5 }]);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'ITEMS_LOCKED', details: { status } });
      expect(await db('order_items').where({ order_id: row.id }).orderBy('sort_order').pluck('quantity')).toEqual([2, 1]);
      expect(Number((await db('orders').where({ id: row.id }).first()).total_tzs)).toBe(1000000);
      expect((await get(row.id)).body.data.order.itemsEditable).toBe(false);
    },
  );

  test('after confirming through the API, the items are locked', async () => {
    const { row, items } = await orderWithItems();
    expect((await post(`${row.id}/status`, { status: 'confirmed' })).status).toBe(200);
    expect((await putItems(row.id, [{ id: items[0].id, quantity: 9 }])).status).toBe(409);
  });

  test('an item change and a confirm at the same time: both end consistent', async () => {
    const { row, items } = await orderWithItems();
    const [edit, confirm] = await Promise.all([
      putItems(row.id, [{ id: items[0].id, quantity: 4 }]),
      post(`${row.id}/status`, { status: 'confirmed' }),
    ]);
    expect(confirm.status).toBe(200);
    const stored = await db('order_items').where({ id: items[0].id }).first('quantity');
    // Either the edit came first (and the confirmed order has it), or it was refused.
    if (edit.status === 200) expect(stored.quantity).toBe(4);
    else {
      expect(edit.status).toBe(409);
      expect(stored.quantity).toBe(2);
    }
  });
});

describe('linking shop orders to customers (M7.5)', () => {
  const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  let staffCookie;

  beforeAll(async () => {
    staffCookie = `psp_sid=${(await sessions.create({ staffId, ip: '::1', userAgent: 't' })).id}`;
  });

  async function customer(over = {}) {
    const [row] = await db('customers')
      .insert({ type: 'individual', full_name: 'Asha Mushi', phone: '+255712345678', created_by: staffId, ...over })
      .returning('*');
    return row;
  }

  const send = (method, id, body) =>
    request(app)[method](`/api/office/orders/${id}/customer`).set('Cookie', staffCookie).set('Origin', ORIGIN).send(body);
  const link = (id, customerId) => send('put', id, { customerId });
  const linkedTo = async (id) => (await db('orders').where({ id }).first('customer_id')).customer_id;

  test('need a session and the office origin', async () => {
    const { id } = await order();
    const c = await customer();
    const noSession = await request(app).put(`/api/office/orders/${id}/customer`).set('Origin', ORIGIN).send({ customerId: c.id });
    expect(noSession.status).toBe(401);
    const noOrigin = await request(app)
      .put(`/api/office/orders/${id}/customer`)
      .set('Cookie', staffCookie)
      .send({ customerId: c.id });
    expect(noOrigin.status).toBe(403);
    expect(await linkedTo(id)).toBeNull();
  });

  test("the order's phone and email find matching customers through the duplicates check", async () => {
    const byPhone = await customer({ full_name: 'Asha M.' });
    const byEmail = await customer({ full_name: 'Asha Office', phone: null, email: 'asha@example.com' });
    await customer({ full_name: 'Someone else', phone: '+255754000000' });
    const row = await order({ guest_email: 'asha@example.com' });

    const res = await request(app)
      .get('/api/office/customers/duplicates')
      .query({ phone: row.guest_phone, email: row.guest_email })
      .set('Cookie', staffCookie);
    expect(res.status).toBe(200);
    const matches = Object.fromEntries(res.body.data.matches.map((m) => [m.id, m.matchedOn]));
    expect(matches).toEqual({ [byPhone.id]: ['phone'], [byEmail.id]: ['email'] });
  });

  test('links a shop order to an existing customer, in any status', async () => {
    const c = await customer({ type: 'company', full_name: null, company_name: 'Bugando Medical Centre' });
    for (const status of ['new', 'delivered', 'cancelled']) {
      const { id } = await inStatus(status);
      const res = await link(id, c.id);
      expect(res.status).toBe(200);
      expect(res.body.data.order.customer).toEqual({ id: c.id, type: 'company', name: 'Bugando Medical Centre' });
      expect(res.body.data.order.status).toBe(status);
      expect(await linkedTo(id)).toBe(c.id);
    }
  });

  test('linking again to the same customer is fine; another customer needs an unlink first', async () => {
    const first = await customer();
    const second = await customer({ full_name: 'Juma Said', phone: '+255754100200' });
    const { id } = await order();
    await link(id, first.id);

    expect((await link(id, first.id)).status).toBe(200);
    const other = await link(id, second.id);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('ORDER_LINKED');
    expect(other.body.error.details).toEqual({ customerId: first.id });
    expect(await linkedTo(id)).toBe(first.id);

    const unlinked = await send('delete', id);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.data.order.customer).toBeNull();
    expect(await db('customers').where({ id: first.id }).first('id')).toBeTruthy();
    expect((await send('delete', id)).status).toBe(200); // already unlinked

    expect((await link(id, second.id)).status).toBe(200);
    expect(await linkedTo(id)).toBe(second.id);
  });

  test('refuses a bad or unknown customer, a missing order and staff orders', async () => {
    const c = await customer();
    const { id } = await order();

    for (const body of [{}, { customerId: 'nope' }, { customerId: 42 }]) {
      const res = await send('put', id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual({ customerId: 'Choose a customer.' });
    }
    const unknown = await link(id, MISSING_ID);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual({ customerId: 'This customer no longer exists.' });
    expect(await linkedTo(id)).toBeNull();

    expect((await link(MISSING_ID, c.id)).status).toBe(404);
    expect((await link('nope', c.id)).status).toBe(404);
    expect((await send('post', MISSING_ID)).status).toBe(404);
    expect((await send('delete', MISSING_ID)).status).toBe(404);

    const staffOrder = await order({ source: 'staff', created_by: staffId, customer_id: c.id });
    for (const res of [await link(staffOrder.id, c.id), await send('post', staffOrder.id), await send('delete', staffOrder.id)]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_SHOP_ORDER');
    }
    expect(await linkedTo(staffOrder.id)).toBe(c.id);
  });

  test('creates a customer from the order and links it', async () => {
    const row = await order({ guest_email: 'asha@example.com', delivery_area: 'Kariakoo, Dar es Salaam' });
    const res = await send('post', row.id);
    expect(res.status).toBe(201);

    const created = await db('customers').first();
    expect(created).toMatchObject({
      type: 'individual',
      full_name: 'Asha Mushi',
      company_name: null,
      phone: '+255712345678',
      email: 'asha@example.com',
      notes: `Added from shop order ${row.order_number}.`,
      created_by: staffId,
    });
    expect(await db('customer_addresses').where({ customer_id: created.id }).select('label', 'area', 'address', 'is_default')).toEqual([
      { label: '', area: 'Kariakoo, Dar es Salaam', address: 'Msimbazi Street', is_default: true },
    ]);
    expect(res.body.data.order.customer).toEqual({ id: created.id, type: 'individual', name: 'Asha Mushi' });
    expect(await linkedTo(row.id)).toBe(created.id);

    // The guest snapshot on the order is unchanged.
    const after = await db('orders').where({ id: row.id }).first();
    expect([after.guest_name, after.guest_phone, after.guest_email]).toEqual(['Asha Mushi', '+255712345678', 'asha@example.com']);
  });

  test('never creates two customers for one order', async () => {
    const { id } = await order();
    const results = await Promise.all([send('post', id), send('post', id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('ORDER_LINKED');
    expect(Number((await db('customers').count('* as n'))[0].n)).toBe(1);

    const linked = await order({ customer_id: (await customer({ full_name: 'Kept' })).id });
    expect((await send('post', linked.id)).status).toBe(409);
    expect(Number((await db('customers').count('* as n'))[0].n)).toBe(2);
  });

  test("the queue lists one customer's orders for the customer detail page", async () => {
    const mine = await customer();
    const other = await customer({ full_name: 'Juma Said' });
    const a = await order({ customer_id: mine.id, created_at: new Date(Date.UTC(2026, 9, 1)) });
    const b = await order({ customer_id: mine.id, status: 'confirmed', confirmed_at: db.fn.now() });
    await order({ customer_id: other.id });
    await order();

    const res = await request(app).get('/api/office/orders').query({ customerId: mine.id }).set('Cookie', staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.orders.map((o) => o.id)).toEqual([b.id, a.id]);
    expect(res.body.data.orders.every((o) => o.customerId === mine.id)).toBe(true);

    const bad = await request(app).get('/api/office/orders').query({ customerId: 'nope' }).set('Cookie', staffCookie);
    expect(bad.status).toBe(400);
  });
});

describe('extend_orders migration', () => {
  const columns = async () =>
    (
      await db('information_schema.columns')
        .where({ table_name: 'orders' })
        .whereIn('column_name', ['created_by', 'cancel_reason', 'confirmed_at', 'delivered_at', 'closed_at', 'cancelled_at', 'paid_at'])
        .pluck('column_name')
    ).sort();
  const customerForeignKey = async () =>
    (
      await db.raw(
        "select count(*)::int as n from pg_constraint where conrelid = 'orders'::regclass and contype = 'f' " +
          "and confrelid = 'customers'::regclass",
      )
    ).rows[0].n;

  test('migrates down and up again, keeping existing orders', async () => {
    const [, pending] = await db.migrate.list();
    expect(pending).toEqual([]);
    const { id } = await order();

    await db.migrate.down({ name: MIGRATION });
    expect(await columns()).toEqual([]);
    expect(await customerForeignKey()).toBe(0);
    expect(await db('orders').where({ id }).first('id')).toBeTruthy();

    await db.migrate.latest();
    expect(await columns()).toEqual(
      ['cancel_reason', 'cancelled_at', 'closed_at', 'confirmed_at', 'created_by', 'delivered_at', 'paid_at'],
    );
    expect(await customerForeignKey()).toBe(1);
  });
});

describe('staff-created orders (M7.4)', () => {
  const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  let staffCookie;
  let counter = 0;

  beforeAll(async () => {
    staffCookie = `psp_sid=${(await sessions.create({ staffId, ip: '::1', userAgent: 't' })).id}`;
  });

  beforeEach(async () => {
    await db('product_images').del();
    await db('products').del();
  });

  async function product(over = {}) {
    counter += 1;
    const [row] = await db('products')
      .insert({
        name: `Monitor ${counter}`,
        slug: `monitor-${counter}`,
        sku: `SKU-${counter}`,
        category_id: 1,
        price_tzs: 1000000,
        quantity_in_stock: 5,
        is_published: true,
        is_archived: false,
        created_by: staffId,
        ...over,
      })
      .returning('*');
    return row;
  }

  async function customer(over = {}) {
    const [row] = await db('customers')
      .insert({ type: 'individual', full_name: 'Asha Mushi', phone: '+255712345678', created_by: staffId, ...over })
      .returning('*');
    await db('customer_addresses').insert({ customer_id: row.id, area: 'Kariakoo', address: 'Msimbazi Street', is_default: true });
    return row;
  }

  const create = (body, cookie = staffCookie) =>
    request(app).post('/api/office/orders').set('Cookie', cookie).set('Origin', ORIGIN).send(body);
  const orderCount = async () => Number((await db('orders').count('* as n').first()).n);

  test('need a session and the office origin', async () => {
    const p = await product();
    const body = { guestName: 'Walk In', guestPhone: '0712345678', deliveryArea: 'Kariakoo', deliveryAddress: 'Shop 4', items: [{ productId: p.id, quantity: 1 }] };
    expect((await request(app).post('/api/office/orders').set('Origin', ORIGIN).send(body)).status).toBe(401);
    expect((await request(app).post('/api/office/orders').set('Cookie', staffCookie).send(body)).status).toBe(403);
    expect(await orderCount()).toBe(0);
  });

  test('creates a new, unpaid staff order for a customer, copying their details in', async () => {
    const c = await customer({ email: 'asha@example.com' });
    const p = await product({ price_tzs: 250000 });

    const res = await create({ customerId: c.id, notes: 'Phone call', items: [{ productId: p.id, quantity: 3 }] });

    expect(res.status).toBe(201);
    const { order } = res.body.data;
    expect(order).toMatchObject({
      source: 'staff',
      status: 'new',
      paymentStatus: 'unpaid',
      customer: { id: c.id },
      createdBy: { id: staffId },
      guestName: 'Asha Mushi',
      guestPhone: '+255712345678',
      guestEmail: 'asha@example.com',
      deliveryArea: 'Kariakoo',
      deliveryAddress: 'Msimbazi Street',
      notes: 'Phone call',
      totalTzs: 750000,
      hasQuotationLines: false,
      itemsEditable: true,
    });
    expect(order.orderNumber).toMatch(/^PSP-\d+$/);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ productId: p.id, productName: p.name, productSku: p.sku, unitPriceTzs: 250000, quantity: 3, lineTotalTzs: 750000 });
  });

  test('a guest sale needs a name, phone and address, and has no customer', async () => {
    const p = await product();
    const bad = await create({ items: [{ productId: p.id, quantity: 1 }] });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details).sort()).toEqual(
      ['deliveryAddress', 'deliveryArea', 'guestName', 'guestPhone'],
    );

    const res = await create({
      guestName: 'Walk In',
      guestPhone: '0754 111 222',
      deliveryArea: 'Mikocheni',
      deliveryAddress: 'Near the market',
      items: [{ productId: p.id, quantity: 2 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.order).toMatchObject({ source: 'staff', customer: null, guestPhone: '+255754111222', totalTzs: 2000000 });
  });

  test('ignores any price, name or total sent by the client', async () => {
    const c = await customer();
    const p = await product({ price_tzs: 400000 });

    const res = await create({
      customerId: c.id,
      totalTzs: 1,
      items: [{ productId: p.id, quantity: 2, unitPriceTzs: 1, name: 'Free monitor', priceTzs: 1 }],
    });

    expect(res.status).toBe(201);
    const { order } = res.body.data;
    expect(order.totalTzs).toBe(800000);
    expect(order.items[0]).toMatchObject({ productName: p.name, unitPriceTzs: 400000 });
  });

  test('quotation lines are saved without a price and left out of the total', async () => {
    const c = await customer();
    const priced = await product({ price_tzs: 100000 });
    const quote = await product({ price_tzs: null, request_quotation: true });

    const res = await create({
      customerId: c.id,
      items: [{ productId: priced.id, quantity: 1 }, { productId: quote.id, quantity: 1 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.order.totalTzs).toBe(100000);
    expect(res.body.data.order.hasQuotationLines).toBe(true);
    expect(res.body.data.order.items[1]).toMatchObject({ unitPriceTzs: null, lineTotalTzs: null });
  });

  test('refuses draft, archived, unknown and out-of-stock products, saving nothing', async () => {
    const c = await customer();
    const ok = await product();
    const draft = await product({ is_published: false });
    const archived = await product({ is_published: false, is_archived: true });
    const out = await product({ quantity_in_stock: 0 });

    const res = await create({
      customerId: c.id,
      items: [
        { productId: ok.id, quantity: 1 },
        { productId: draft.id, quantity: 1 },
        { productId: archived.id, quantity: 1 },
        { productId: out.id, quantity: 1 },
        { productId: MISSING_ID, quantity: 1 },
      ],
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LINES_UNAVAILABLE');
    expect(res.body.error.details.lines.map((line) => [line.index, line.code])).toEqual([
      [1, 'UNAVAILABLE'],
      [2, 'UNAVAILABLE'],
      [3, 'OUT_OF_STOCK'],
      [4, 'UNAVAILABLE'],
    ]);
    expect(await orderCount()).toBe(0);
  });

  test('refuses an unknown customer, bad quantities and repeated products', async () => {
    const p = await product();

    const unknown = await create({ customerId: MISSING_ID, items: [{ productId: p.id, quantity: 1 }] });
    expect(unknown.status).toBe(400);

    const c = await customer();
    const bad = await create({
      customerId: c.id,
      items: [{ productId: p.id, quantity: 0 }, { productId: p.id, quantity: 100 }],
    });
    expect(bad.status).toBe(400);
    expect(await orderCount()).toBe(0);
  });

  test('a staff order can then be confirmed like any other', async () => {
    const c = await customer();
    const p = await product();
    const created = await create({ customerId: c.id, items: [{ productId: p.id, quantity: 1 }] });

    const res = await request(app)
      .post(`/api/office/orders/${created.body.data.order.id}/status`)
      .set('Cookie', staffCookie)
      .set('Origin', ORIGIN)
      .send({ status: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('confirmed');
  });
});
