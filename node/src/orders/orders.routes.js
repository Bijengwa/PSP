const express = require('express');
const { httpError, requireSameOrigin, requireAuth, requirePermission } = require('../auth/auth.middleware');
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
  linkOrderToCustomer,
  unlinkOrderCustomer,
  createCustomerFromOrder,
  createStaffOrder,
} = require('./orders.service');
const { findCustomer } = require('../customers/customers.service');

// Office orders, mounted at /api/office/orders. Every route needs an orders.* permission,
// read from Postgres on each request.
const router = express.Router();
router.use(requireSameOrigin, requireAuth());

// An optional query value that must be one of `allowed`.
function oneOf(req, name, allowed) {
  const value = req.query[name] || undefined;
  if (value && !allowed.includes(value)) throw httpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/', requirePermission('orders.view'), async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const status = oneOf(req, 'status', ORDER_STATUSES);
  const paymentStatus = oneOf(req, 'paymentStatus', PAYMENT_STATUSES);
  const source = oneOf(req, 'source', ORDER_SOURCES);
  const customerId = req.query.customerId || undefined;
  if (customerId && (typeof customerId !== 'string' || !UUID_PATTERN.test(customerId))) {
    throw httpError(400, 'customerId must be a customer id');
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  res.json({
    success: true,
    data: await listOrders({ q, status, paymentStatus, source, customerId, page, limit: ORDER_PAGE_SIZE }),
  });
});

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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TZ_PHONE_PATTERN = /^(?:\+?255|0)?([267]\d{8})$/;
const MAX_ORDER_LINES = 50;
const text = (raw) => (typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '');

// A new staff order (M7.4). Body: { customerId?, guestName?, guestPhone?, guestEmail?,
// deliveryArea?, deliveryAddress?, notes?, items: [{ productId, quantity }] }. With a
// customer, any detail left out is copied from the customer (name, phone, email and
// default address); without one, name, phone and the address are required. Prices and
// names come only from the database. Starts as a new, unpaid staff order.
router.post('/', requirePermission('orders.create'), async (req, res) => {
  const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const fields = {};

  let customer = null;
  if (input.customerId !== undefined && input.customerId !== null && input.customerId !== '') {
    if (typeof input.customerId !== 'string' || !UUID_PATTERN.test(input.customerId)) {
      fields.customerId = 'Choose a customer.';
    } else {
      customer = await findCustomer(input.customerId.toLowerCase());
      if (!customer) fields.customerId = 'This customer no longer exists.';
    }
  }
  const home = customer?.addresses?.[0];

  const name = text(input.guestName) || (customer ? customer.companyName || customer.fullName || '' : '');
  if (name.length < 2 || name.length > 100) fields.guestName = 'Enter the name (2 to 100 characters).';

  let phone = null;
  const typedPhone = typeof input.guestPhone === 'string' ? input.guestPhone.trim() : '';
  if (typedPhone) {
    const match = typedPhone.replace(/[\s()-]/g, '').match(TZ_PHONE_PATTERN);
    phone = match ? `+255${match[1]}` : null;
  } else if (customer?.phone) {
    phone = customer.phone;
  }
  if (!phone) fields.guestPhone = 'Enter a Tanzanian phone number, for example 0712 345 678.';

  const email = (text(input.guestEmail) || customer?.email || '').toLowerCase();
  if (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) fields.guestEmail = 'Enter a valid email address.';

  const area = text(input.deliveryArea) || home?.area || '';
  if (area.length < 2 || area.length > 100) fields.deliveryArea = 'Enter the area or city (2 to 100 characters).';
  const address = text(input.deliveryAddress) || home?.address || '';
  if (address.length < 2 || address.length > 200) {
    fields.deliveryAddress = 'Enter a street or landmark (2 to 200 characters).';
  }

  let notes = '';
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== 'string') {
    fields.notes = 'Notes must be text.';
  } else {
    notes = (input.notes ?? '').trim();
    if (notes.length > 1000) fields.notes = 'Use at most 1000 characters.';
  }

  const lines = [];
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_ORDER_LINES) {
    fields.items = `Add between 1 and ${MAX_ORDER_LINES} products.`;
  } else {
    const seen = new Set();
    input.items.forEach((line, index) => {
      const productId = typeof line?.productId === 'string' ? line.productId.toLowerCase() : null;
      const quantity = line?.quantity;
      if (!productId || !UUID_PATTERN.test(productId)) fields[`items.${index}.productId`] = 'Unknown product.';
      else if (seen.has(productId)) fields[`items.${index}.productId`] = 'This product is already in the order.';
      if (productId) seen.add(productId);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > ITEM_QUANTITY_MAX) {
        fields[`items.${index}.quantity`] = `Enter a quantity from 1 to ${ITEM_QUANTITY_MAX}.`;
      }
      lines.push({ productId, quantity });
    });
  }
  if (Object.keys(fields).length) throw validationError(fields);

  const result = await createStaffOrder({
    customerId: customer?.id ?? null,
    guest: {
      guest_name: name,
      guest_phone: phone,
      guest_email: email || null,
      delivery_area: area,
      delivery_address: address,
      notes,
    },
    lines,
    createdBy: req.staff.id,
  });
  if (result.problems) {
    throw Object.assign(
      httpError(409, 'Some products are no longer available.', 'LINES_UNAVAILABLE'),
      { details: { lines: result.problems } },
    );
  }

  req.log.info(
    { event: 'order.created', orderId: result.order.id, orderNumber: result.order.orderNumber, by: req.staff.id },
    'Staff order created',
  );
  res.status(201);
  await sendOrder(res, result.order.id);
});

router.get('/:id', requirePermission('orders.view'), async (req, res) => {
  await sendOrder(res, idParam(req));
});

// Moves the order one step along its life cycle: confirm, deliver, close, or cancel
// (with a reason). Any other move is a 409 that names the order's current status.
router.post('/:id/status', requirePermission('orders.update'), async (req, res) => {
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

router.post('/:id/paid', requirePermission('orders.update'), async (req, res) => {
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
router.put('/:id/items', requirePermission('orders.update'), async (req, res) => {
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

// Linking a shop order to a customer (M7.5). The refusals shared by the three routes.
function linkRefusal(result) {
  if (result.error === 'not_shop_order') {
    return httpError(409, 'Only shop orders are linked here. A staff order has its customer from the start.', 'NOT_SHOP_ORDER');
  }
  if (result.error === 'already_linked') {
    return Object.assign(
      httpError(409, 'This order is already linked to a customer. Unlink it first to choose another.', 'ORDER_LINKED'),
      { details: { customerId: result.customerId } },
    );
  }
  return null;
}

// Links the order to an existing customer. Body: { customerId }.
router.put('/:id/customer', requirePermission('orders.link'), async (req, res) => {
  const id = idParam(req);
  const customerId = req.body?.customerId;
  if (typeof customerId !== 'string' || !UUID_PATTERN.test(customerId)) {
    throw validationError({ customerId: 'Choose a customer.' });
  }

  const result = await linkOrderToCustomer(id, customerId);
  if (!result) throw httpError(404, 'Not found');
  const refusal = linkRefusal(result);
  if (refusal) throw refusal;
  if (result.error === 'unknown_customer') throw validationError({ customerId: 'This customer no longer exists.' });

  req.log.info({ event: 'order.customer_linked', orderId: id, customerId, by: req.staff.id }, 'Order linked to customer');
  await sendOrder(res, id);
});

// Creates a customer from the order's guest details and links the order to it.
router.post('/:id/customer', requirePermission('orders.link', 'customers.create'), async (req, res) => {
  const id = idParam(req);
  const result = await createCustomerFromOrder(id, req.staff.id);
  if (!result) throw httpError(404, 'Not found');
  const refusal = linkRefusal(result);
  if (refusal) throw refusal;

  req.log.info(
    { event: 'order.customer_created', orderId: id, customerId: result.customer.id, by: req.staff.id },
    'Customer created from order',
  );
  res.status(201);
  await sendOrder(res, id);
});

router.delete('/:id/customer', requirePermission('orders.link'), async (req, res) => {
  const id = idParam(req);
  const result = await unlinkOrderCustomer(id);
  if (!result) throw httpError(404, 'Not found');
  const refusal = linkRefusal(result);
  if (refusal) throw refusal;

  req.log.info({ event: 'order.customer_unlinked', orderId: id, by: req.staff.id }, 'Order unlinked from customer');
  await sendOrder(res, id);
});

module.exports = router;
