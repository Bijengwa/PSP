const request = require('supertest');

// The shop API never touches Redis; a dead stand-in proves it.
jest.mock('../redis', () => ({
  client: new Proxy({}, { get: () => () => Promise.reject(new Error('Redis must not be used by the shop')) }),
  connect() {},
  disconnect: async () => {},
}));

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
  await db('product_images').del();
  await db('products').del();
});

afterAll(async () => {
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
      { name: 'Imaging', slug: 'imaging', productCount: 1 },
      { name: 'Patient monitoring', slug: 'patient-monitoring', productCount: 2 },
    ]);
  });

  test('is empty when nothing is live', async () => {
    await product({ is_published: false });
    const res = await request(app).get('/api/shop/categories');
    expect(res.body.data.categories).toEqual([]);
  });
});
