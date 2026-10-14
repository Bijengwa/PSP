const db = require('../db');

const ORDER_STATUSES = ['new', 'confirmed', 'delivered', 'closed', 'cancelled'];
const PAYMENT_STATUSES = ['unpaid', 'paid'];
const CANCEL_REASON_MAX = 500;

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

module.exports = {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  STATUS_TRANSITIONS,
  CANCEL_REASON_MAX,
  canChangeStatus,
  changeOrderStatus,
  markOrderPaid,
};
