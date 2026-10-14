const express = require('express');
const { httpError } = require('../auth/auth.middleware');
const {
  SHOP_PAGE_SIZE,
  SHOP_SORTS,
  listShopCategories,
  listShopProducts,
  getShopProduct,
  getCartPrices,
} = require('./shop.service');

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

// A malformed slug can never match, so it gets the same 404 as a draft or archived product.
router.get('/products/:slug', async (req, res) => {
  const { slug } = req.params;
  const found = slug.length <= 200 && SLUG_PATTERN.test(slug) ? await getShopProduct(slug) : null;
  if (!found) throw httpError(404, 'Product not found');
  res.json({ success: true, data: found });
});

const MAX_CART_LINES = 50;
const MAX_QUANTITY = 99;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clampQuantity = (value) => Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(value)) || 1));

// Current name, price, photo and availability for the cart page. Takes
// [{ productId, quantity }]; any price, name or total the client sends is ignored.
// Ids that are not UUIDs can never match, so they are left out like a draft would be.
router.post('/cart/prices', async (req, res) => {
  if (!Array.isArray(req.body) || req.body.length > MAX_CART_LINES) {
    throw httpError(400, `Send a list of up to ${MAX_CART_LINES} cart lines`);
  }

  const lines = new Map();
  for (const line of req.body) {
    const productId = line?.productId;
    if (typeof productId !== 'string' || !UUID_PATTERN.test(productId)) continue;
    const id = productId.toLowerCase();
    lines.set(id, clampQuantity((lines.get(id) ?? 0) + clampQuantity(line.quantity)));
  }

  const items = await getCartPrices([...lines].map(([productId, quantity]) => ({ productId, quantity })));
  res.json({ success: true, data: { items } });
});

module.exports = router;
