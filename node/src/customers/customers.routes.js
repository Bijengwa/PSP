const express = require('express');
const { httpError, requireSameOrigin, requireAuth } = require('../auth/auth.middleware');
const { CUSTOMER_TYPES, CUSTOMER_PAGE_SIZE, listCustomers } = require('./customers.service');

// Office customer directory, mounted at /api/office/customers. Any signed-in staff
// member may use it until the permissions stage (H3-H5) replaces role checks.
const router = express.Router();
router.use(requireSameOrigin, requireAuth());

router.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const type = req.query.type || undefined;
  if (type && !CUSTOMER_TYPES.includes(type)) {
    throw httpError(400, `type must be one of: ${CUSTOMER_TYPES.join(', ')}`);
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  res.json({ success: true, data: await listCustomers({ q, type, page, limit: CUSTOMER_PAGE_SIZE }) });
});

module.exports = router;
