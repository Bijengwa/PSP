const db = require('../db');
const { phoneDigits } = require('../customers/customers.service');

const ORDER_STATUSES = ['new', 'confirmed', 'delivered', 'closed', 'cancelled'];
const PAYMENT_STATUSES = ['unpaid', 'paid'];
const ORDER_SOURCES = ['shop', 'staff'];
const CANCEL_REASON_MAX = 500;
const ORDER_PAGE_SIZE = 25;

// The order life cycle: new → confirmed → delivered → closed, or cancelled from
// new/confirmed. Closed and cancelled are final. Nothing moves backwards.
const STATUS_TRANSITIONS = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['delivered', 'cancelled'],
  delivered: ['closed'],
  closed: [],
  cancelled: [],
};

// The column stamped when an order reaches each status.
const STATUS_TIMESTAMPS = {
  confirmed: 'confirmed_at',
  delivered: 'delivered_at',
  closed: 'closed_at',
  cancelled: 'cancelled_at',
};

function canChangeStatus(from, to) {
  return (STATUS_TRANSITIONS[from] ?? []).includes(to);
}

// The statuses from which an order may move to `to`.
function statusesLeadingTo(to) {
  return ORDER_STATUSES.filter((from) => canChangeStatus(from, to));
}

// Moves an order to `to`, only along the life cycle. Cancelling needs a reason.
// Returns { order }, null when the order does not exist, or { error } with
// 'invalid_status', 'reason_required' or 'invalid_transition' (with `from`).
// The update itself checks the current status, so two staff acting at once
// cannot both move the same order.
async function changeOrderStatus(id, to, { reason } = {}) {
  if (!ORDER_STATUSES.includes(to) || to === 'new') return { error: 'invalid_status' };

  const update = { status: to, [STATUS_TIMESTAMPS[to]]: db.fn.now(), updated_at: db.fn.now() };
  if (to === 'cancelled') {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text || text.length > CANCEL_REASON_MAX) return { error: 'reason_required' };
    update.cancel_reason = text;
  }

  const [order] = await db('orders')
    .where({ id })
    .whereIn('status', statusesLeadingTo(to))
    .update(update)
    .returning('*');
  if (order) return { order };

  const current = await db('orders').where({ id }).first('status');
  if (!current) return null;
  return { error: 'invalid_transition', from: current.status };
}

// Payment moves only from unpaid to paid, and never on a cancelled order.
// Returns { order }, null when the order does not exist, or { error } with
// 'already_paid' or 'cancelled'.
async function markOrderPaid(id) {
  const [order] = await db('orders')
    .where({ id, payment_status: 'unpaid' })
    .whereNot({ status: 'cancelled' })
    .update({ payment_status: 'paid', paid_at: db.fn.now(), updated_at: db.fn.now() })
    .returning('*');
  if (order) return { order };

  const current = await db('orders').where({ id }).first('status', 'payment_status');
  if (!current) return null;
  return { error: current.payment_status === 'paid' ? 'already_paid' : 'cancelled' };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

// One row of the orders queue. Delivery details, notes and items stay for the detail page.
function toListOrder(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    paymentStatus: row.payment_status,
    source: row.source,
    customerId: row.customer_id,
    guestName: row.guest_name,
    guestPhone: row.guest_phone,
    deliveryArea: row.delivery_area,
    totalTzs: Number(row.total_tzs),
    hasQuotationLines: row.has_quotation_lines,
    itemCount: Number(row.item_count),
    createdAt: row.created_at,
  };
}

// The orders queue: search by order number, name or phone, filter by status, payment
// status and source, paged, newest first. `total` counts every match; `counts` is how
// many each status tab would show with the same search and other filters.
async function listOrders({ q, status, paymentStatus, source, page = 1, limit = ORDER_PAGE_SIZE }) {
  const filters = (query, { withStatus = true } = {}) => {
    if (q) {
      const like = `%${escapeLike(q)}%`;
      const digits = phoneDigits(q);
      query.where((b) => {
        b.whereILike('orders.order_number', like)
          .orWhereILike('orders.guest_name', like)
          .orWhereILike('orders.guest_phone', like);
        if (digits) b.orWhereLike('orders.guest_phone', `%${digits}%`);
      });
    }
    if (withStatus && status) query.where('orders.status', status);
    if (paymentStatus) query.where('orders.payment_status', paymentStatus);
    if (source) query.where('orders.source', source);
    return query;
  };

  const itemCount = db('order_items')
    .whereRaw('order_items.order_id = orders.id')
    .sum('quantity')
    .as('item_count');

  const [rows, [{ count }], [counts]] = await Promise.all([
    filters(db('orders'))
      .orderBy([{ column: 'orders.created_at', order: 'desc' }, { column: 'orders.id' }])
      .limit(limit)
      .offset((page - 1) * limit)
      .select('orders.*', itemCount),
    filters(db('orders')).count('* as count'),
    filters(db('orders'), { withStatus: false }).select(
      db.raw('count(*) as all_count'),
      ...ORDER_STATUSES.map((name) => db.raw('count(*) filter (where status = ?) as ??', [name, name])),
    ),
  ]);

  return {
    total: Number(count),
    page,
    pageSize: limit,
    counts: Object.fromEntries([
      ['all', Number(counts.all_count)],
      ...ORDER_STATUSES.map((name) => [name, Number(counts[name])]),
    ]),
    orders: rows.map(toListOrder),
  };
}

module.exports = {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  ORDER_SOURCES,
  ORDER_PAGE_SIZE,
  STATUS_TRANSITIONS,
  CANCEL_REASON_MAX,
  canChangeStatus,
  changeOrderStatus,
  markOrderPaid,
  listOrders,
};
