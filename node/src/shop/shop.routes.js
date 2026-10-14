const express = require('express');
const { httpError } = require('../auth/auth.middleware');
const rateLimit = require('../auth/rate-limit');
const {
  SHOP_PAGE_SIZE,
  SHOP_SORTS,
  listShopCategories,
  listShopProducts,
  getShopProduct,
  getCartPrices,
  createShopOrder,
} = require('./shop.service');

// Public shop API, mounted at /api/shop. Open to everyone, no session. The read
// routes never touch Redis; only placing an order does (rate limiting). Only live
// (published, not archived) products are returned or sold.
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Tanzanian numbers: 9 digits after +255 or a leading 0. Mobiles start with 6 or 7,
// landlines with 2.
const TZ_PHONE_PATTERN = /^(?:\+?255|0)?([267]\d{8})$/;

const text = (raw) => (typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '');

// "0712 345 678", "+255 712-345-678", "(255) 712345678" -> "+255712345678", or null.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.replace(/[\s()-]/g, '').match(TZ_PHONE_PATTERN);
  return match ? `+255${match[1]}` : null;
}

// Validates a checkout body: { name, phone, email?, area, address, notes?, items }.
// Only product ids and quantities are taken from `items`; any price, name or total
// sent alongside is ignored. Returns { fields } (field -> message) or { guest, lines }.
function parseOrder(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const fields = {};

  const name = text(input.name);
  if (name.length < 2 || name.length > 100) fields.name = 'Enter your name (2 to 100 characters).';

  const phone = normalizePhone(input.phone);
  if (!phone) fields.phone = 'Enter a Tanzanian phone number, for example 0712 345 678.';

  const email = text(input.email).toLowerCase();
  if (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) fields.email = 'Enter a valid email address.';

  const area = text(input.area);
  if (area.length < 2 || area.length > 100) fields.area = 'Enter the area or city (2 to 100 characters).';

  const address = text(input.address);
  if (address.length < 2 || address.length > 200) {
    fields.address = 'Enter a street or landmark (2 to 200 characters).';
  }

  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== 'string') {
    fields.notes = 'Notes must be text.';
  } else if (notes.length > 1000) fields.notes = 'Use at most 1000 characters.';

  const lines = [];
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_CART_LINES) {
    fields.items = `Send between 1 and ${MAX_CART_LINES} order lines.`;
  } else {
    const seen = new Set();
    input.items.forEach((line, index) => {
      const productId = line?.productId;
      const quantity = line?.quantity;
      if (typeof productId !== 'string' || !UUID_PATTERN.test(productId)) {
        fields[`items.${index}.productId`] = 'Unknown product.';
      } else if (seen.has(productId.toLowerCase())) {
        fields[`items.${index}.productId`] = 'This product is already in the order.';
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
        fields[`items.${index}.quantity`] = `Quantity must be between 1 and ${MAX_QUANTITY}.`;
      }
      if (typeof productId === 'string') seen.add(productId.toLowerCase());
      lines.push({ productId: typeof productId === 'string' ? productId.toLowerCase() : null, quantity });
    });
  }

  if (Object.keys(fields).length) return { fields };
  return {
    guest: {
      guest_name: name,
      guest_phone: phone,
      guest_email: email || null,
      delivery_area: area,
      delivery_address: address,
      notes,
    },
    lines,
  };
}

// Guest checkout (C5). Pay later, no account. Rate limited per IP and per phone
// (Redis down: 503). `website` is a hidden honeypot field: people leave it empty.
// Nothing personal is logged here; the response is the order number and total only.
router.post('/orders', async (req, res) => {
  if (typeof req.body?.website === 'string' && req.body.website !== '') {
    throw httpError(400, 'The order could not be placed.', 'REJECTED');
  }

  const parsed = parseOrder(req.body);
  if (parsed.fields) {
    throw Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: parsed.fields });
  }

  await rateLimit.enforce(res, 'order', { ip: req.ip, phone: parsed.guest.guest_phone });

  const result = await createShopOrder(parsed.guest, parsed.lines);
  if (result.problems) {
    throw Object.assign(
      httpError(409, 'Some products in your cart are no longer available.', 'LINES_UNAVAILABLE'),
      { details: { lines: result.problems } },
    );
  }

  req.log.info({ event: 'shop_order.created', orderNumber: result.order.orderNumber }, 'Shop order placed');
  res.status(201).json({ success: true, data: result.order });
});

module.exports = router;
