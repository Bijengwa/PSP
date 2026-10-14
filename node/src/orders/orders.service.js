const db = require('../db');
const { phoneDigits, createCustomer } = require('../customers/customers.service');

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

// A line's quantity, as checkout allows it.
const ITEM_QUANTITY_MAX = 99;

const money = (value) => (value === null || value === undefined ? null : Number(value));

// One order with everything the detail page shows: items, the delivery snapshot, the
// linked customer, who entered a staff order, and when each status was reached.
// `nextStatuses` and `itemsEditable` say what staff may still do with it.
function toOrderDetail(row, items) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    paymentStatus: row.payment_status,
    source: row.source,
    customer: row.customer_id
      ? { id: row.customer_id, type: row.customer_type, name: row.customer_company_name || row.customer_full_name }
      : null,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name } : null,
    guestName: row.guest_name,
    guestPhone: row.guest_phone,
    guestEmail: row.guest_email,
    deliveryArea: row.delivery_area,
    deliveryAddress: row.delivery_address,
    notes: row.notes,
    totalTzs: Number(row.total_tzs),
    hasQuotationLines: row.has_quotation_lines,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    deliveredAt: row.delivered_at,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
    paidAt: row.paid_at,
    nextStatuses: STATUS_TRANSITIONS[row.status] ?? [],
    itemsEditable: row.status === 'new',
    items: items.map((item) => ({
      id: item.id,
      productId: item.product_id,
      productName: item.product_name,
      productSku: item.product_sku,
      unitPriceTzs: money(item.unit_price_tzs),
      quantity: item.quantity,
      lineTotalTzs: money(item.line_total_tzs),
    })),
  };
}

// The detail of one order, or null when it does not exist.
async function findOrder(id) {
  const row = await db('orders')
    .leftJoin('customers', 'customers.id', 'orders.customer_id')
    .leftJoin('staff_profiles', 'staff_profiles.id', 'orders.created_by')
    .where('orders.id', id)
    .first(
      'orders.*',
      'customers.type as customer_type',
      'customers.full_name as customer_full_name',
      'customers.company_name as customer_company_name',
      'staff_profiles.full_name as created_by_name',
    );
  if (!row) return null;
  const items = await db('order_items').where({ order_id: id }).orderBy([{ column: 'sort_order' }, { column: 'id' }]);
  return toOrderDetail(row, items);
}

// Changes the quantities of a new order's lines, or drops lines. `lines` is the full list
// to keep: [{ id, quantity }]. Prices stay as copied in at checkout; line totals, the
// order total and the quotation flag are worked out again. Once an order is confirmed
// its items never change. Returns { updated: true }, null when the order does not exist,
// or { error } with 'items_locked' (with `status`), 'unknown_item' or 'no_items'.
// The order row is locked first, so a confirm arriving at the same time waits for this.
async function updateOrderItems(id, lines) {
  return db.transaction(async (trx) => {
    const order = await trx('orders').where({ id }).forUpdate().first('status');
    if (!order) return null;
    if (order.status !== 'new') return { error: 'items_locked', status: order.status };
    if (lines.length === 0) return { error: 'no_items' };

    const items = await trx('order_items').where({ order_id: id });
    const byId = new Map(items.map((item) => [item.id, item]));
    if (lines.some((line) => !byId.has(line.id))) return { error: 'unknown_item' };

    const keep = new Set(lines.map((line) => line.id));
    const dropped = items.filter((item) => !keep.has(item.id)).map((item) => item.id);
    if (dropped.length) await trx('order_items').whereIn('id', dropped).del();

    let total = 0;
    let hasQuotationLines = false;
    for (const line of lines) {
      const unit = money(byId.get(line.id).unit_price_tzs);
      const lineTotal = unit === null ? null : unit * line.quantity;
      if (lineTotal === null) hasQuotationLines = true;
      else total += lineTotal;
      await trx('order_items')
        .where({ id: line.id })
        .update({ quantity: line.quantity, line_total_tzs: lineTotal, updated_at: trx.fn.now() });
    }

    await trx('orders')
      .where({ id })
      .update({ total_tzs: total, has_quotation_lines: hasQuotationLines, updated_at: trx.fn.now() });
    return { updated: true };
  });
}

// Linking shop orders to customers (M7.5). Only shop (guest) orders are linked here;
// staff orders get their customer when they are entered. The order's guest and
// delivery snapshot never changes. Each function locks the order row first, so two
// staff linking the same order at once cannot both win. They return null when the
// order does not exist, or { error } with 'not_shop_order' or 'already_linked'
// (with `customerId`, the customer it is linked to now).
async function lockShopOrder(trx, id) {
  const order = await trx('orders').where({ id }).forUpdate().first();
  if (!order) return { missing: true };
  if (order.source !== 'shop') return { error: 'not_shop_order' };
  return { order };
}

// Links the order to an existing customer. Linking it again to the same customer is a
// no-op; a different customer must be unlinked first. Returns { linked: true }, or
// { error: 'unknown_customer' } as well as the errors above.
async function linkOrderToCustomer(id, customerId) {
  return db.transaction(async (trx) => {
    const { missing, error, order } = await lockShopOrder(trx, id);
    if (missing) return null;
    if (error) return { error };
    if (order.customer_id === customerId) return { linked: true };
    if (order.customer_id) return { error: 'already_linked', customerId: order.customer_id };
    if (!(await trx('customers').where({ id: customerId }).first('id'))) return { error: 'unknown_customer' };

    await trx('orders').where({ id }).update({ customer_id: customerId, updated_at: trx.fn.now() });
    return { linked: true };
  });
}

// Removes the link, keeping the order and the customer. Unlinking an unlinked order is
// a no-op. Returns { unlinked: true } or the errors above.
async function unlinkOrderCustomer(id) {
  return db.transaction(async (trx) => {
    const { missing, error, order } = await lockShopOrder(trx, id);
    if (missing) return null;
    if (error) return { error };
    if (order.customer_id) {
      await trx('orders').where({ id }).update({ customer_id: null, updated_at: trx.fn.now() });
    }
    return { unlinked: true };
  });
}

// Creates an individual customer from the order's guest details (name, phone, email,
// and the delivery address as the default address) and links the order to it, in one
// transaction. Refused when the order is already linked, so a double click cannot make
// two customers. Returns { customer } or the errors above.
async function createCustomerFromOrder(id, createdBy) {
  return db.transaction(async (trx) => {
    const { missing, error, order } = await lockShopOrder(trx, id);
    if (missing) return null;
    if (error) return { error };
    if (order.customer_id) return { error: 'already_linked', customerId: order.customer_id };

    const customer = await createCustomer(
      {
        values: {
          type: 'individual',
          fullName: order.guest_name,
          companyName: null,
          tin: null,
          contactPerson: null,
          phone: order.guest_phone,
          email: order.guest_email,
          notes: `Added from shop order ${order.order_number}.`,
        },
        addresses: [{ label: '', area: order.delivery_area, address: order.delivery_address, isDefault: true }],
        createdBy,
      },
      trx,
    );
    await trx('orders').where({ id }).update({ customer_id: customer.id, updated_at: trx.fn.now() });
    return { customer };
  });
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
// status, source and linked customer (the customer detail page, M7.5), paged, newest
// first. `total` counts every match; `counts` is how many each status tab would show
// with the same search and other filters.
async function listOrders({ q, status, paymentStatus, source, customerId, page = 1, limit = ORDER_PAGE_SIZE }) {
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
    if (customerId) query.where('orders.customer_id', customerId);
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
  ITEM_QUANTITY_MAX,
  canChangeStatus,
  changeOrderStatus,
  markOrderPaid,
  listOrders,
  findOrder,
  updateOrderItems,
  linkOrderToCustomer,
  unlinkOrderCustomer,
  createCustomerFromOrder,
};
