const express = require('express');
const { httpError, requireSameOrigin, requireAuth } = require('../auth/auth.middleware');
const { ORDER_STATUSES, PAYMENT_STATUSES, ORDER_SOURCES, ORDER_PAGE_SIZE, listOrders } = require('./orders.service');

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

module.exports = router;
