const express = require('express');
const { httpError, requireSameOrigin, requireAuth } = require('../auth/auth.middleware');
const {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  ORDER_SOURCES,
  ORDER_PAGE_SIZE,
  CANCEL_REASON_MAX,
  ITEM_QUANTITY_MAX,
  listOrders,
  findOrder,
  changeOrderStatus,
  markOrderPaid,
  updateOrderItems,
} = require('./orders.service');

// Office orders, mounted at /api/office/orders. Any signed-in staff member may use it
// until the permissions stage (H3-H5) replaces role checks.
const router = express.Router();
router.use(requireSameOrigin, requireAuth());

// An optional query value that must be one of `allowed`.
function oneOf(req, name, allowed) {
  const value = req.query[name] || undefined;
  if (value && !allowed.includes(value)) throw httpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

router.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const status = oneOf(req, 'status', ORDER_STATUSES);
  const paymentStatus = oneOf(req, 'paymentStatus', PAYMENT_STATUSES);
  const source = oneOf(req, 'source', ORDER_SOURCES);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  res.json({
    success: true,
    data: await listOrders({ q, status, paymentStatus, source, page, limit: ORDER_PAGE_SIZE }),
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idParam(req) {
  if (!UUID_PATTERN.test(req.params.id)) throw httpError(404, 'Not found');
  return req.params.id;
}

function validationError(fields) {
  return Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: fields });
}

// Answers with the order as it is now, after a change.
async function sendOrder(res, id) {
  const order = await findOrder(id);
  if (!order) throw httpError(404, 'Not found');
  res.json({ success: true, data: { order } });
}

router.get('/:id', async (req, res) => {
  await sendOrder(res, idParam(req));
});

// Moves the order one step along its life cycle: confirm, deliver, close, or cancel
// (with a reason). Any other move is a 409 that names the order's current status.
router.post('/:id/status', async (req, res) => {
  const id = idParam(req);
  const to = req.body?.status;
  const result = await changeOrderStatus(id, to, { reason: req.body?.reason });
  if (!result) throw httpError(404, 'Not found');
  if (result.error === 'invalid_status') {
    throw validationError({ status: 'Choose confirmed, delivered, closed or cancelled.' });
  }
  if (result.error === 'reason_required') {
    throw validationError({ reason: `Enter the reason for cancelling (1 to ${CANCEL_REASON_MAX} characters).` });
  }
  if (result.error === 'invalid_transition') {
    throw Object.assign(
      httpError(409, `This order is ${result.from}, so it cannot be moved to ${to}.`, 'INVALID_TRANSITION'),
      { details: { status: result.from } },
    );
  }

  req.log.info({ event: 'order.status_changed', orderId: id, status: to, by: req.staff.id }, 'Order status changed');
  await sendOrder(res, id);
});

router.post('/:id/paid', async (req, res) => {
  const id = idParam(req);
  const result = await markOrderPaid(id);
  if (!result) throw httpError(404, 'Not found');
  if (result.error === 'already_paid') throw httpError(409, 'This order is already marked paid.', 'ALREADY_PAID');
  if (result.error === 'cancelled') throw httpError(409, 'A cancelled order cannot be marked paid.', 'ORDER_CANCELLED');

  req.log.info({ event: 'order.paid', orderId: id, by: req.staff.id }, 'Order marked paid');
  await sendOrder(res, id);
});

// Changes quantities or drops lines while the order is still new. Body:
// { items: [{ id, quantity }] }, the full list of lines to keep. After confirmation the
// items are fixed (409 ITEMS_LOCKED).
router.put('/:id/items', async (req, res) => {
  const id = idParam(req);
  const raw = req.body?.items;
  if (!Array.isArray(raw) || raw.length === 0) throw validationError({ items: 'Keep at least one line. To drop the whole order, cancel it.' });

  const fields = {};
  const seen = new Set();
  const lines = raw.map((line, index) => {
    const itemId = typeof line?.id === 'string' && UUID_PATTERN.test(line.id) ? line.id : null;
    if (!itemId || seen.has(itemId)) fields[`items.${index}.id`] = 'Unknown or repeated line.';
    seen.add(itemId);
    const { quantity } = line ?? {};
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > ITEM_QUANTITY_MAX) {
      fields[`items.${index}.quantity`] = `Enter a quantity from 1 to ${ITEM_QUANTITY_MAX}.`;
    }
    return { id: itemId, quantity };
  });
  if (Object.keys(fields).length) throw validationError(fields);

  const result = await updateOrderItems(id, lines);
  if (!result) throw httpError(404, 'Not found');
  if (result.error === 'items_locked') {
    throw Object.assign(
      httpError(409, `This order is ${result.status}. Its items can no longer change.`, 'ITEMS_LOCKED'),
      { details: { status: result.status } },
    );
  }
  if (result.error === 'unknown_item') throw validationError({ items: 'A line does not belong to this order.' });

  req.log.info({ event: 'order.items_changed', orderId: id, by: req.staff.id }, 'Order items changed');
  await sendOrder(res, id);
});

module.exports = router;
