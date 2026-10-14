const express = require('express');
const { httpError } = require('../auth/auth.middleware');
const { SHOP_PAGE_SIZE, SHOP_SORTS, listShopCategories, listShopProducts } = require('./shop.service');

// Public shop API, mounted at /api/shop. Read-only and open to everyone: no
// session, no Redis. Only live (published, not archived) products are returned.
const router = express.Router();

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PAGE = 10000;

router.get('/categories', async (req, res) => {
  res.json({ success: true, data: { categories: await listShopCategories() } });
});

router.get('/products', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';

  const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
  if (category !== undefined && (category.length > 80 || !SLUG_PATTERN.test(category))) {
    throw httpError(400, 'category must be a category slug');
  }

  const sort = req.query.sort || 'newest';
  if (!SHOP_SORTS.includes(sort)) throw httpError(400, `sort must be one of: ${SHOP_SORTS.join(', ')}`);

  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(req.query.page, 10) || 1));

  res.json({
    success: true,
    data: await listShopProducts({ q, category, sort, page, limit: SHOP_PAGE_SIZE }),
  });
});

module.exports = router;
