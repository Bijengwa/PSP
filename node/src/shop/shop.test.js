const request = require('supertest');

// The shop's read routes never touch Redis: the stand-in is dead by default, which
// proves it. Placing an order uses it for rate limiting, so those tests switch it on.
jest.mock('../redis', () => {
  const fake = {
    alive: false,
    data: new Map(),
    expiry: new Map(),
    check() {
      if (!fake.alive) throw new Error('Redis must not be used by the shop');
    },
    ttl(key) {
      return fake.expiry.has(key) ? Math.ceil((fake.expiry.get(key) - Date.now()) / 1000) : -1;
    },
    multi() {
      const ops = [];
      const chain = {
        incr: (key) => (ops.push(() => fake.data.set(key, (fake.data.get(key) ?? 0) + 1).get(key)), chain),
        expire: (key, seconds, mode) =>
          (ops.push(() => {
            if (mode === 'NX' && fake.expiry.has(key)) return 0;
            fake.expiry.set(key, Date.now() + seconds * 1000);
            return 1;
          }),
          chain),
        ttl: (key) => (ops.push(() => fake.ttl(key)), chain),
        exec: async () => {
          fake.check();
          return ops.map((op) => op());
        },
      };
      return chain;
    },
  };
  return {
    fake,
    client: new Proxy(
      {},
      {
        get: (target, prop) =>
          prop === 'multi' ? () => fake.multi() : () => Promise.reject(new Error('Redis must not be used by the shop')),
      },
    ),
    connect() {},
    disconnect: async () => {},
  };
});

const db = require('../db');
const { app } = require('../server');

const SHOP_KEYS = ['brand', 'category', 'id', 'imageUrl', 'inStock', 'name', 'priceTzs', 'requestQuotation', 'slug'];

let staffId;
let counter = 0;

// Inserts a product straight into the table, live by default.
async function product(over = {}) {
  counter += 1;
  const [row] = await db('products')
    .insert({
      name: `Product ${counter}`,
      slug: `product-${counter}`,
      sku: `SECRET-SKU-${counter}`,
      category_id: 1,
      brand: 'Mindray',
      price_tzs: 1000000,
      cost_price_tzs: 777777,
      quantity_in_stock: 5,
      is_published: true,
      is_archived: false,
      created_by: staffId,
      ...over,
    })
    .returning('*');
  return row;
}

const list = (query = '') => request(app).get(`/api/shop/products${query}`);

beforeAll(async () => {
  await db.migrate.latest();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  const [role] = await db('roles').insert({ name: 'staff', description: 'Staff' }).returning('id');
  const [staff] = await db('staff_profiles')
    .insert({ full_name: 'Sam Staff', email: 's@psp.test', password_hash: 'x', role_id: role.id, must_change_password: false })
    .returning('id');
  staffId = staff.id;
});

beforeEach(async () => {
  await db('order_items').del();
  await db('orders').del();
  await db('product_images').del();
  await db('products').del();
});

afterAll(async () => {
  await db('order_items').del();
  await db('orders').del();
  await db('product_images').del();
  await db('products').del();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  await db.destroy();
});

describe('GET /api/shop/products', () => {
  test('needs no session and sets no cookie', async () => {
    await product();
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.data.total).toBe(1);
  });

  test('drafts and archived products never appear', async () => {
    const live = await product({ name: 'Live monitor' });
    await product({ name: 'Draft monitor', is_published: false });
    await product({ name: 'Archived monitor', is_published: false, is_archived: true });

    const res = await list('?q=monitor');
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.products.map((p) => p.id)).toEqual([live.id]);
    expect(JSON.stringify(res.body)).not.toMatch(/Draft monitor|Archived monitor/);
  });

  test('returns only shop-safe fields: no SKU, cost, stock number or created_by', async () => {
    const row = await product({ quantity_in_stock: 42 });
    await db('product_images').insert([
      { product_id: row.id, url: '/uploads/products/second.png', sort_order: 1, is_main: false },
      { product_id: row.id, url: '/uploads/products/main.png', sort_order: 0, is_main: true },
    ]);

    const res = await list();
    const [item] = res.body.data.products;
    expect(Object.keys(item).sort()).toEqual(SHOP_KEYS);
    expect(item).toEqual({
      id: row.id,
      name: row.name,
      slug: row.slug,
      brand: 'Mindray',
      category: { name: 'Imaging', slug: 'imaging' },
      priceTzs: 1000000,
      requestQuotation: false,
      inStock: true,
      imageUrl: '/uploads/products/main.png',
    });
    const body = JSON.stringify(res.body);
    for (const secret of [row.sku, '777777', staffId, 'created_by', 'cost', 'quantity', 'sku']) {
      expect(body).not.toContain(secret);
    }
  });

  test('stock is a boolean; quotation products hide their price; no photo gives null', async () => {
    await product({ name: 'Empty shelf', quantity_in_stock: 0 });
    await product({ name: 'Quote only', request_quotation: true, price_tzs: 5000000 });

    const res = await list('?sort=name');
    const [empty, quote] = res.body.data.products;
    expect(empty).toMatchObject({ name: 'Empty shelf', inStock: false, imageUrl: null });
    expect(quote).toMatchObject({ name: 'Quote only', requestQuotation: true, priceTzs: null, inStock: true });
    expect(JSON.stringify(res.body)).not.toContain('5000000');
  });

  test('search matches name, brand and SKU, and treats % and _ literally', async () => {
    await product({ name: 'Infusion pump', brand: 'Baxter' });
    await product({ name: 'Bedside monitor', brand: 'Philips', sku: 'PSP-PM-12345' });
    await product({ name: '100% cotton sheet', brand: null });

    const names = async (q) => (await list(`?q=${encodeURIComponent(q)}`)).body.data.products.map((p) => p.name);
    expect(await names('PUMP')).toEqual(['Infusion pump']);
    expect(await names('philips')).toEqual(['Bedside monitor']);
    expect(await names('pm-12345')).toEqual(['Bedside monitor']);
    expect(await names('%')).toEqual(['100% cotton sheet']);
    expect(await names('_')).toEqual([]);
  });

  test('filters by category slug; an unknown slug is empty, a malformed one is refused', async () => {
    await product({ name: 'Scanner', category_id: 1 });
    await product({ name: 'Monitor', category_id: 2 });

    const res = await list('?category=patient-monitoring');
    expect(res.body.data.products.map((p) => p.name)).toEqual(['Monitor']);
    expect(res.body.data.total).toBe(1);

    expect((await list('?category=no-such-thing')).body.data).toMatchObject({ total: 0, products: [] });
    expect((await list('?category=Bad%20Slug')).status).toBe(400);
  });

  test('sorts by newest, price (quotation last) and name; refuses unknown sorts', async () => {
    await product({ name: 'B mid', price_tzs: 500, created_at: new Date('2026-01-01') });
    await product({ name: 'C quote', price_tzs: null, request_quotation: true, created_at: new Date('2026-03-01') });
    await product({ name: 'A cheap', price_tzs: 100, created_at: new Date('2026-02-01') });
    await product({ name: 'D dear', price_tzs: 900, created_at: new Date('2025-12-01') });

    const order = async (sort) => (await list(`?sort=${sort}`)).body.data.products.map((p) => p.name);
    expect(await order('newest')).toEqual(['C quote', 'A cheap', 'B mid', 'D dear']);
    expect(await order('price_asc')).toEqual(['A cheap', 'B mid', 'D dear', 'C quote']);
    expect(await order('price_desc')).toEqual(['D dear', 'B mid', 'A cheap', 'C quote']);
    expect(await order('name')).toEqual(['A cheap', 'B mid', 'C quote', 'D dear']);
    expect((await list('?sort=cost')).status).toBe(400);
  });

  test('pages of 12 with the full total', async () => {
    for (let n = 0; n < 14; n += 1) await product({ name: `Item ${String(n).padStart(2, '0')}` });

    const first = (await list('?sort=name')).body.data;
    expect(first).toMatchObject({ total: 14, page: 1, pageSize: 12 });
    expect(first.products).toHaveLength(12);

    const second = (await list('?sort=name&page=2')).body.data;
    expect(second.products.map((p) => p.name)).toEqual(['Item 12', 'Item 13']);

    expect((await list('?page=9')).body.data).toMatchObject({ total: 14, products: [] });
    expect((await list('?page=abc')).body.data.page).toBe(1);
  });
});

describe('GET /api/shop/products/:slug', () => {
  const one = (slug) => request(app).get(`/api/shop/products/${slug}`);
  const DETAIL_KEYS = [...SHOP_KEYS, 'description', 'images', 'sku', 'specs'].sort();

  test('returns a live product with its page fields only, and sets no cookie', async () => {
    const row = await product({
      slug: 'bedside-monitor',
      quantity_in_stock: 42,
      description: 'Bedside monitor for wards.',
      specs: JSON.stringify([{ label: 'Display', value: '12.1" TFT' }]),
    });
    await db('product_images').insert([
      { product_id: row.id, url: '/uploads/products/second.png', sort_order: 1, is_main: false },
      { product_id: row.id, url: '/uploads/products/third.png', sort_order: 2, is_main: false },
      { product_id: row.id, url: '/uploads/products/main.png', sort_order: 5, is_main: true },
    ]);

    const res = await one('bedside-monitor');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const { product: item } = res.body.data;
    expect(Object.keys(item).sort()).toEqual(DETAIL_KEYS);
    expect(item).toMatchObject({
      id: row.id,
      sku: row.sku,
      priceTzs: 1000000,
      inStock: true,
      imageUrl: '/uploads/products/main.png',
      description: 'Bedside monitor for wards.',
      specs: [{ label: 'Display', value: '12.1" TFT' }],
      images: ['/uploads/products/main.png', '/uploads/products/second.png', '/uploads/products/third.png'],
    });
    const body = JSON.stringify(res.body);
    for (const secret of ['777777', staffId, 'created_by', 'cost', 'quantity', 'is_published', 'is_archived']) {
      expect(body).not.toContain(secret);
    }
  });

  test('drafts, archived, unknown and malformed slugs are 404', async () => {
    await product({ slug: 'draft-item', is_published: false });
    await product({ slug: 'archived-item', is_published: false, is_archived: true });

    for (const slug of ['draft-item', 'archived-item', 'no-such-item', 'Bad%20Slug']) {
      const res = await one(slug);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('SECRET-SKU');
    }
  });

  test('quotation products hide their price; out of stock is a boolean', async () => {
    await product({ slug: 'quote', request_quotation: true, price_tzs: 5000000, quantity_in_stock: 0 });
    const res = await one('quote');
    expect(res.body.data.product).toMatchObject({ requestQuotation: true, priceTzs: null, inStock: false, images: [] });
    expect(JSON.stringify(res.body)).not.toContain('5000000');
  });

  test('related: up to 4 live products from the same category, never itself', async () => {
    await product({ slug: 'main', category_id: 2 });
    for (let n = 0; n < 5; n += 1) {
      await product({ name: `Sibling ${n}`, category_id: 2, created_at: new Date(2026, 0, n + 1) });
    }
    await product({ name: 'Draft sibling', category_id: 2, is_published: false, created_at: new Date(2027, 0, 1) });
    await product({ name: 'Other category', category_id: 1, created_at: new Date(2027, 0, 1) });

    const { related } = (await one('main')).body.data;
    expect(related.map((p) => p.name)).toEqual(['Sibling 4', 'Sibling 3', 'Sibling 2', 'Sibling 1']);
    expect(Object.keys(related[0]).sort()).toEqual(SHOP_KEYS);
  });

  test('related is empty when the product is alone in its category', async () => {
    await product({ slug: 'alone', category_id: 3 });
    expect((await one('alone')).body.data.related).toEqual([]);
  });
});

describe('GET /api/shop/categories', () => {
  test('lists only categories with live products, with live counts, in office order', async () => {
    await product({ category_id: 2 });
    await product({ category_id: 2 });
    await product({ category_id: 2, is_published: false });
    await product({ category_id: 1 });
    await product({ category_id: 3, is_published: false, is_archived: true });

    const res = await request(app).get('/api/shop/categories');
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toEqual([
      { name: 'Imaging', slug: 'imaging', productCount: 1, imageUrl: null },
      { name: 'Patient monitoring', slug: 'patient-monitoring', productCount: 2, imageUrl: null },
    ]);
  });

  test('returns the main photo of a live product in the category', async () => {
    const live = await product({ category_id: 2 });
    const draft = await product({ category_id: 2, is_published: false });
    await db('product_images').insert([
      { product_id: live.id, url: '/uploads/products/live-second.png', sort_order: 1, is_main: false },
      { product_id: live.id, url: '/uploads/products/live-main.png', sort_order: 0, is_main: true },
      { product_id: draft.id, url: '/uploads/products/draft.png', sort_order: 0, is_main: true },
    ]);

    const res = await request(app).get('/api/shop/categories');
    expect(res.body.data.categories).toEqual([
      expect.objectContaining({ slug: 'patient-monitoring', imageUrl: '/uploads/products/live-main.png' }),
    ]);
  });

  test('is empty when nothing is live', async () => {
    await product({ is_published: false });
    const res = await request(app).get('/api/shop/categories');
    expect(res.body.data.categories).toEqual([]);
  });
});

describe('POST /api/shop/cart/prices', () => {
  const prices = (body) => request(app).post('/api/shop/cart/prices').send(body);
  const CART_KEYS = ['product', 'quantity'];

  test('returns the current name, price, photo and stock from the database; needs no session', async () => {
    const row = await product({ name: 'Bedside monitor', price_tzs: 4850000, quantity_in_stock: 3 });
    await db('product_images').insert({ product_id: row.id, url: '/uploads/products/main.png', sort_order: 0, is_main: true });

    const res = await prices([{ productId: row.id, quantity: 2 }]);
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const [item] = res.body.data.items;
    expect(Object.keys(item).sort()).toEqual(CART_KEYS);
    expect(Object.keys(item.product).sort()).toEqual(SHOP_KEYS);
    expect(item).toEqual({
      quantity: 2,
      product: {
        id: row.id,
        name: 'Bedside monitor',
        slug: row.slug,
        brand: 'Mindray',
        category: { name: 'Imaging', slug: 'imaging' },
        priceTzs: 4850000,
        requestQuotation: false,
        inStock: true,
        imageUrl: '/uploads/products/main.png',
      },
    });
    const body = JSON.stringify(res.body);
    for (const secret of [row.sku, '777777', staffId, 'created_by', 'cost', 'quantity_in_stock']) {
      expect(body).not.toContain(secret);
    }
  });

  test('ignores any price, name or total sent by the client', async () => {
    const row = await product({ name: 'Real name', price_tzs: 2750000 });
    const res = await prices([
      { productId: row.id, quantity: 1, priceTzs: 1, price_tzs: 1, name: 'Fake name', lineTotalTzs: 1, totalTzs: 1 },
    ]);
    expect(res.body.data.items[0].product).toMatchObject({ name: 'Real name', priceTzs: 2750000 });
    expect(JSON.stringify(res.body)).not.toContain('Fake name');
  });

  test('drops unpublished, archived, unknown and malformed ids, keeping the cart order', async () => {
    const second = await product({ name: 'Second' });
    const draft = await product({ name: 'Draft', is_published: false });
    const archived = await product({ name: 'Archived', is_published: false, is_archived: true });
    const first = await product({ name: 'First' });

    const res = await prices([
      { productId: first.id, quantity: 1 },
      { productId: draft.id, quantity: 1 },
      { productId: archived.id, quantity: 1 },
      { productId: '00000000-0000-4000-8000-000000000000', quantity: 1 },
      { productId: 'not-a-uuid', quantity: 1 },
      { productId: 42, quantity: 1 },
      null,
      { productId: second.id, quantity: 1 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((item) => item.product.name)).toEqual(['First', 'Second']);
    expect(JSON.stringify(res.body)).not.toMatch(/Draft|Archived/);
  });

  test('quotation products hide their price; out of stock is a boolean', async () => {
    const quote = await product({ request_quotation: true, price_tzs: 5000000 });
    const empty = await product({ quantity_in_stock: 0 });

    const res = await prices([
      { productId: quote.id, quantity: 1 },
      { productId: empty.id, quantity: 1 },
    ]);
    const [quoteItem, emptyItem] = res.body.data.items;
    expect(quoteItem.product).toMatchObject({ requestQuotation: true, priceTzs: null });
    expect(emptyItem.product).toMatchObject({ inStock: false, priceTzs: 1000000 });
    expect(JSON.stringify(res.body)).not.toContain('5000000');
  });

  test('merges duplicate lines and clamps quantities to 1–99', async () => {
    const a = await product();
    const b = await product();
    const c = await product();

    const res = await prices([
      { productId: a.id, quantity: 60 },
      { productId: b.id, quantity: 0 },
      { productId: a.id.toUpperCase(), quantity: 60 },
      { productId: c.id, quantity: 'lots' },
    ]);
    expect(res.body.data.items.map((item) => [item.product.id, item.quantity])).toEqual([
      [a.id, 99],
      [b.id, 1],
      [c.id, 1],
    ]);
  });

  test('an empty cart gives no items; anything but a list of up to 50 lines is refused', async () => {
    expect((await prices([])).body.data.items).toEqual([]);
    expect((await prices({ productId: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/shop/cart/prices')).status).toBe(400);
    const tooMany = Array.from({ length: 51 }, () => ({ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }));
    expect((await prices(tooMany)).status).toBe(400);
  });
});

describe('POST /api/shop/orders', () => {
  const { fake } = require('../redis');
  const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
  // Every test request comes from the same IP; the counters are cleared before each
  // test, so only the rate-limit tests reach the limits.
  const place = (body) => request(app).post('/api/shop/orders').send(body);
  const guest = (over = {}) => ({
    name: 'Neema Mushi',
    phone: '0712 345 678',
    email: 'neema@example.com',
    area: 'Mikocheni, Dar es Salaam',
    address: 'Plot 12, near the Total station',
    notes: 'Call before delivery',
    ...over,
  });
  const orderCount = async () => Number((await db('orders').count('* as n'))[0].n);

  beforeEach(() => {
    fake.alive = true;
    fake.data.clear();
    fake.expiry.clear();
  });

  afterEach(() => {
    fake.alive = false;
  });

  test('creates the order from database prices; the response is the number and total only', async () => {
    const monitor = await product({ name: 'Bedside monitor', price_tzs: 4850000 });
    const pump = await product({ name: 'Infusion pump', price_tzs: 1250000, quantity_in_stock: 1 });

    const res = await place({
      ...guest(),
      items: [
        { productId: monitor.id, quantity: 2 },
        { productId: pump.id, quantity: 3 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(Object.keys(res.body.data).sort()).toEqual(['orderNumber', 'totalTzs']);
    expect(res.body.data.orderNumber).toMatch(/^PSP-\d{6}$/);
    expect(res.body.data.totalTzs).toBe(2 * 4850000 + 3 * 1250000);

    const order = await db('orders').where({ order_number: res.body.data.orderNumber }).first();
    expect(order).toMatchObject({
      customer_id: null,
      guest_name: 'Neema Mushi',
      guest_phone: '+255712345678',
      guest_email: 'neema@example.com',
      delivery_area: 'Mikocheni, Dar es Salaam',
      delivery_address: 'Plot 12, near the Total station',
      notes: 'Call before delivery',
      status: 'new',
      payment_status: 'unpaid',
      source: 'shop',
      total_tzs: String(2 * 4850000 + 3 * 1250000),
      has_quotation_lines: false,
    });
    const items = await db('order_items').where({ order_id: order.id }).orderBy('sort_order');
    expect(items.map((i) => [i.product_id, i.product_name, i.product_sku, i.unit_price_tzs, i.quantity, i.line_total_tzs])).toEqual([
      [monitor.id, 'Bedside monitor', monitor.sku, '4850000', 2, '9700000'],
      [pump.id, 'Infusion pump', pump.sku, '1250000', 3, '3750000'],
    ]);

    // Stock is left alone: staff decrease it when they confirm.
    expect((await db('products').where({ id: pump.id }).first()).quantity_in_stock).toBe(1);
  });

  // C6 data path: the cart prices the checkout page shows, then the exact body it posts
  // (web/src/shop/api.ts placeOrder), end up as the saved order with the same items and total.
  test('the checkout page data path: cart prices and the placed order agree on items and total', async () => {
    const monitor = await product({ name: 'Bedside monitor', price_tzs: 4850000 });
    const oximeter = await product({ name: 'Pulse oximeter', price_tzs: 85000 });
    const ct = await product({ name: 'CT scanner', request_quotation: true, price_tzs: null });
    const cart = [
      { productId: monitor.id, quantity: 2 },
      { productId: oximeter.id, quantity: 3 },
      { productId: ct.id, quantity: 1 },
    ];

    // What the summary shows: priced lines summed, quotation lines left out.
    const shown = await request(app).post('/api/shop/cart/prices').send(cart);
    expect(shown.status).toBe(200);
    const summaryTotal = shown.body.data.items
      .filter((item) => !item.product.requestQuotation && item.product.priceTzs !== null)
      .reduce((sum, item) => sum + item.product.priceTzs * item.quantity, 0);
    expect(summaryTotal).toBe(2 * 4850000 + 3 * 85000);

    const res = await place({
      name: 'Neema Mushi',
      phone: '0712 345 678',
      email: '',
      area: 'Mikocheni, Dar es Salaam',
      address: 'Plot 12, near the Total station',
      notes: '',
      website: '',
      items: cart,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.totalTzs).toBe(summaryTotal);

    const order = await db('orders').where({ order_number: res.body.data.orderNumber }).first();
    expect(order).toMatchObject({
      guest_email: null,
      notes: '',
      total_tzs: String(summaryTotal),
      has_quotation_lines: true,
      status: 'new',
      payment_status: 'unpaid',
      source: 'shop',
    });
    const items = await db('order_items').where({ order_id: order.id }).orderBy('sort_order');
    expect(items.map((i) => [i.product_id, i.product_name, i.quantity, i.unit_price_tzs, i.line_total_tzs])).toEqual([
      [monitor.id, 'Bedside monitor', 2, '4850000', '9700000'],
      [oximeter.id, 'Pulse oximeter', 3, '85000', '255000'],
      [ct.id, 'CT scanner', 1, null, null],
    ]);
  });

  test('order numbers come from a sequence and are unique', async () => {
    const row = await product();
    const first = await place({ ...guest(), items: [{ productId: row.id, quantity: 1 }] });
    const second = await place({ ...guest({ phone: '0754 000 111' }), items: [{ productId: row.id, quantity: 1 }] });
    const number = (res) => Number(res.body.data.orderNumber.slice(4));
    expect(number(second)).toBe(number(first) + 1);
  });

  test('a tampered price, name or total has no effect', async () => {
    const row = await product({ name: 'Real name', price_tzs: 2750000 });
    const res = await place({
      ...guest(),
      totalTzs: 1,
      total_tzs: 1,
      status: 'paid',
      payment_status: 'paid',
      source: 'staff',
      customer_id: UNKNOWN_ID,
      items: [{ productId: row.id, quantity: 2, priceTzs: 1, unitPriceTzs: 1, name: 'Fake name', sku: 'FAKE', lineTotalTzs: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.totalTzs).toBe(5500000);

    const order = await db('orders').where({ order_number: res.body.data.orderNumber }).first();
    expect(order).toMatchObject({ total_tzs: '5500000', status: 'new', payment_status: 'unpaid', source: 'shop', customer_id: null });
    const [item] = await db('order_items').where({ order_id: order.id });
    expect(item).toMatchObject({ product_name: 'Real name', product_sku: row.sku, unit_price_tzs: '2750000', line_total_tzs: '5500000' });
  });

  test('quotation lines are saved without a price and left out of the total', async () => {
    const priced = await product({ price_tzs: 1000000 });
    const quote = await product({ name: 'CT scanner', request_quotation: true, price_tzs: 900000000 });

    const res = await place({
      ...guest(),
      items: [
        { productId: priced.id, quantity: 1 },
        { productId: quote.id, quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.totalTzs).toBe(1000000);
    const order = await db('orders').where({ order_number: res.body.data.orderNumber }).first();
    expect(order.has_quotation_lines).toBe(true);
    const quoteItem = await db('order_items').where({ order_id: order.id, product_id: quote.id }).first();
    expect(quoteItem).toMatchObject({ product_name: 'CT scanner', unit_price_tzs: null, line_total_tzs: null, quantity: 1 });
  });

  test('unpublished, archived, unknown and out-of-stock products are refused per line; nothing is saved', async () => {
    const live = await product();
    const draft = await product({ is_published: false });
    const archived = await product({ is_published: false, is_archived: true });
    const empty = await product({ quantity_in_stock: 0 });

    const res = await place({
      ...guest(),
      items: [
        { productId: live.id, quantity: 1 },
        { productId: draft.id, quantity: 1 },
        { productId: archived.id, quantity: 1 },
        { productId: UNKNOWN_ID, quantity: 1 },
        { productId: empty.id, quantity: 1 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LINES_UNAVAILABLE');
    expect(res.body.error.details.lines).toEqual([
      { index: 1, productId: draft.id, code: 'UNAVAILABLE' },
      { index: 2, productId: archived.id, code: 'UNAVAILABLE' },
      { index: 3, productId: UNKNOWN_ID, code: 'UNAVAILABLE' },
      { index: 4, productId: empty.id, code: 'OUT_OF_STOCK' },
    ]);
    expect(await orderCount()).toBe(0);
  });

  test('accepts Tanzanian phone formats and stores them as +255…', async () => {
    const row = await product();
    for (const phone of ['0712345678', '712 345 678', '+255 712-345-678', '255712345678', '(0712) 345 678', '0222 123 456']) {
      const res = await place({ ...guest({ phone }), items: [{ productId: row.id, quantity: 1 }] });
      expect(res.status).toBe(201);
      const order = await db('orders').where({ order_number: res.body.data.orderNumber }).first();
      expect(order.guest_phone).toMatch(/^\+255[267]\d{8}$/);
    }
  });

  test('invalid input gives field errors and saves nothing', async () => {
    const row = await product();
    const res = await place({
      name: 'N',
      phone: '+254 712 345 678',
      email: 'not-an-email',
      area: '',
      address: ' ',
      notes: 'x'.repeat(1001),
      items: [
        { productId: 'not-a-uuid', quantity: 1 },
        { productId: row.id, quantity: 0 },
        { productId: row.id, quantity: 100 },
        { productId: UNKNOWN_ID, quantity: 1.5 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details).sort()).toEqual(
      [
        'name',
        'phone',
        'email',
        'area',
        'address',
        'notes',
        'items.0.productId',
        'items.1.quantity',
        'items.2.productId',
        'items.2.quantity',
        'items.3.quantity',
      ].sort(),
    );
    expect(await orderCount()).toBe(0);
  });

  test('the email is optional; lines must be a list of 1 to 50', async () => {
    const row = await product();
    const noEmail = await place({ ...guest({ email: '' }), items: [{ productId: row.id, quantity: 1 }] });
    expect(noEmail.status).toBe(201);
    const order = await db('orders').where({ order_number: noEmail.body.data.orderNumber }).first();
    expect(order.guest_email).toBeNull();

    for (const items of [undefined, [], 'lots', Array.from({ length: 51 }, () => ({ productId: row.id, quantity: 1 }))]) {
      const res = await place({ ...guest(), items });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toHaveProperty('items');
    }
    expect((await place()).status).toBe(400);
  });

  test('a filled honeypot field is refused without saving anything', async () => {
    const row = await product();
    const res = await place({ ...guest(), website: 'http://spam.example', items: [{ productId: row.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REJECTED');
    expect(await orderCount()).toBe(0);
  });

  test('rate limited per phone: the 6th order in an hour gets 429 with Retry-After', async () => {
    const row = await product();
    const body = { ...guest(), items: [{ productId: row.id, quantity: 1 }] };
    for (let i = 0; i < 5; i += 1) expect((await place(body)).status).toBe(201);

    const res = await place(body);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
    expect(await orderCount()).toBe(5);

    // The same number written another way is the same phone.
    expect((await place({ ...body, phone: '+255712345678' })).status).toBe(429);
    // The phone is hashed in the key: Redis never holds the number.
    expect([...fake.data.keys()].join(' ')).not.toMatch(/712345678/);
  });

  test('rate limited per IP: the 11th order from one address gets 429 with Retry-After', async () => {
    const row = await product();
    for (let i = 0; i < 10; i += 1) {
      const phone = `07540001${String(i).padStart(2, '0')}`;
      expect((await place({ ...guest({ phone }), items: [{ productId: row.id, quantity: 1 }] })).status).toBe(201);
    }
    const res = await place({ ...guest({ phone: '0754000199' }), items: [{ productId: row.id, quantity: 1 }] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  test('Redis down: 503 and no order (fails closed)', async () => {
    const row = await product();
    fake.alive = false;
    const res = await place({ ...guest(), items: [{ productId: row.id, quantity: 1 }] });
    expect(res.status).toBe(503);
    expect(await orderCount()).toBe(0);
  });

  test('a failure half-way through leaves no half order, and the error carries no personal data', async () => {
    const row = await product();
    // Fails the order_items insert, after the orders row was written in the same transaction.
    await db.raw(`
      create function c5_fail_items() returns trigger language plpgsql as $$
      begin raise exception 'simulated failure'; end $$;
      create trigger c5_fail_items before insert on order_items for each statement execute function c5_fail_items();
    `);
    try {
      const res = await place({ ...guest(), items: [{ productId: row.id, quantity: 1 }] });
      expect(res.status).toBe(500);
      expect(res.body.error.message).toBe('Internal server error');
      expect(await orderCount()).toBe(0);
      expect(await db('order_items').count('* as n').first()).toEqual({ n: '0' });
    } finally {
      await db.raw('drop trigger c5_fail_items on order_items; drop function c5_fail_items();');
    }
  });

  test('the service strips row data from database errors', async () => {
    const { createShopOrder } = require('./shop.service');
    const row = await product();
    // A guest name over the column size: Postgres rejects it; the error must not repeat it.
    const err = await createShopOrder(
      {
        guest_name: 'Secret Person '.repeat(20),
        guest_phone: '+255712345678',
        guest_email: null,
        delivery_area: 'Area',
        delivery_address: 'Street',
        notes: '',
      },
      [{ productId: row.id, quantity: 1 }],
    ).catch((e) => e);
    expect(err.message).toBe('Could not save the order');
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toMatch(/Secret Person|712345678/);
    expect(await orderCount()).toBe(0);
  });
});

describe('create_orders migration', () => {
  test('migrates down and up again', async () => {
    const tables = async () =>
      (await db('information_schema.tables').whereIn('table_name', ['orders', 'order_items']).pluck('table_name')).sort();
    const sequence = async () => (await db.raw("select to_regclass('order_number_seq') as seq")).rows[0].seq;

    const [, pending] = await db.migrate.list();
    expect(pending).toEqual([]);

    // extend_orders (M7.1) alters these tables, so it goes first.
    await db.migrate.down({ name: '20261014220000_extend_orders.js' });
    await db.migrate.down({ name: '20261014180000_create_orders.js' });
    expect(await tables()).toEqual([]);
    expect(await sequence()).toBeNull();

    await db.migrate.latest();
    expect(await tables()).toEqual(['order_items', 'orders']);
    expect(await sequence()).not.toBeNull();
  });
});
