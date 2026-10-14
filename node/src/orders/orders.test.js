const db = require('../db');
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
