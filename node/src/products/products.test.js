const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// Every log line the API writes during this file, exactly as it would reach stdout.
const mockLogLines = [];
jest.mock('../logger', () => {
  const actual = jest.requireActual('../logger');
  return {
    ...actual,
    logger: actual.createLogger({ env: 'test', level: 'info', destination: { write: (line) => mockLogLines.push(line) } }),
  };
});

// In-memory stand-in for the node-redis client, covering the commands the
// session store uses. `failing = true` makes every command reject, like a
// client whose connection is down with the offline queue disabled.
jest.mock('../redis', () => {
  class FakeRedis {
    constructor() {
      this.flush();
    }
    flush() {
      this.data = new Map();
      this.expiry = new Map();
      this.failing = false;
    }
    check() {
      if (this.failing) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    }
    alive(key) {
      const at = this.expiry.get(key);
      if (at !== undefined && at <= Date.now()) {
        this.data.delete(key);
        this.expiry.delete(key);
      }
      return this.data.has(key);
    }
    ttl(key) {
      return this.alive(key) && this.expiry.has(key) ? Math.ceil((this.expiry.get(key) - Date.now()) / 1000) : -1;
    }
    async ping() {
      this.check();
      return 'PONG';
    }
    async get(key) {
      this.check();
      return this.alive(key) ? this.data.get(key) : null;
    }
    async set(key, value, options) {
      this.check();
      this.data.set(key, value);
      this.expiry.delete(key);
      if (options?.expiration) this.expiry.set(key, Date.now() + options.expiration.value * 1000);
      return 'OK';
    }
    async getDel(key) {
      const value = await this.get(key);
      this.data.delete(key);
      this.expiry.delete(key);
      return value;
    }
    async del(keys) {
      this.check();
      let removed = 0;
      for (const key of [].concat(keys)) {
        if (this.alive(key)) removed += 1;
        this.data.delete(key);
        this.expiry.delete(key);
      }
      return removed;
    }
    async sAdd(key, member) {
      this.check();
      if (!this.alive(key)) this.data.set(key, new Set());
      this.data.get(key).add(member);
      return 1;
    }
    async sRem(key, member) {
      this.check();
      return this.alive(key) && this.data.get(key).delete(member) ? 1 : 0;
    }
    async sMembers(key) {
      this.check();
      return this.alive(key) ? [...this.data.get(key)] : [];
    }
    async expire(key, seconds, mode) {
      this.check();
      if (!this.alive(key)) return 0;
      if (mode === 'NX' && this.expiry.has(key)) return 0;
      this.expiry.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    async incr(key) {
      this.check();
      const next = (this.alive(key) ? Number(this.data.get(key)) : 0) + 1;
      this.data.set(key, String(next));
      return next;
    }
    multi() {
      const queued = [];
      const chain = new Proxy(
        {},
        {
          get: (_, name) =>
            name === 'exec'
              ? async () => {
                  this.check();
                  const results = [];
                  for (const [command, args] of queued) results.push(await this[command](...args));
                  return results;
                }
              : (...args) => {
                  queued.push([name, args]);
                  return chain;
                },
        },
      );
      return chain;
    }
  }
  return { client: new FakeRedis(), connect() {}, disconnect: async () => {} };
});

const os = require('os');
const fs = require('fs');
const path = require('path');

// Photos go to a throwaway folder, set before the app (and its static route) loads.
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-uploads-'));
process.env.UPLOADS_DIR = UPLOADS;

const db = require('../db');
const { grantMatrix } = require('../auth/permissions.testing');
const redis = require('../redis');
const { app } = require('../server');
const { hashPassword } = require('../auth/password');
const sessions = require('../auth/session.store');
const { onlyLive } = require('./products.service');

const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

let adminCookie;
let staffCookie;

const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).set('Origin', ORIGIN).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).set('Origin', ORIGIN).send(body),
});

const valid = (over = {}) => ({
  name: 'Ultrasound Scanner X1',
  sku: 'us-x1',
  categoryId: 1,
  description: 'Portable scanner',
  specs: [{ label: 'Power', value: '220 V' }],
  priceTzs: 12500000,
  ...over,
});

beforeAll(async () => {
  await db.migrate.latest();
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  const [admin] = await db('roles').insert({ name: 'IT', description: 'Full access' }).returning('id');
  const [staff] = await db('roles').insert({ name: 'staff', description: 'Staff' }).returning('id');
  await grantMatrix();
  const hash = await hashPassword('Correct-Horse-42!');
  const rows = await db('staff_profiles')
    .insert([
      { full_name: 'Asha Admin', email: 'a@psp.test', password_hash: hash, role_id: admin.id, must_change_password: false },
      { full_name: 'Sam Staff', email: 's@psp.test', password_hash: hash, role_id: staff.id, must_change_password: false },
    ])
    .returning('id');
  adminCookie = `psp_sid=${(await sessions.create({ staffId: rows[0].id, ip: '::1', userAgent: 't' })).id}`;
  staffCookie = `psp_sid=${(await sessions.create({ staffId: rows[1].id, ip: '::1', userAgent: 't' })).id}`;
});

beforeEach(async () => {
  await db('product_images').del();
  await db('products').del();
});

afterAll(async () => {
  await db.raw('truncate staff_profiles, roles restart identity cascade');
  await db.destroy();
  fs.rmSync(UPLOADS, { recursive: true, force: true });
});

describe('products API', () => {
  test('requires a session', async () => {
    const res = await request(app).get('/api/office/products');
    expect(res.status).toBe(401);
  });

  test('a normal staff member can use it (no admin role needed)', async () => {
    const res = await as(staffCookie).get('/api/office/products');
    expect(res.status).toBe(200);
    expect(res.body.data.products).toEqual([]);
  });

  test('lists the seeded categories', async () => {
    const res = await as(adminCookie).get('/api/office/products/categories');
    expect(res.body.data.categories.map((c) => c.name)).toEqual([
      'Imaging',
      'Patient monitoring',
      'Laboratory',
      'Hospital furniture',
      'Respiratory',
      'Infusion',
      'Sterilization',
      'Dental',
    ]);
  });

  test('creates a draft with an uppercase SKU, a slug and created_by', async () => {
    const res = await as(staffCookie).post('/api/office/products', valid());
    expect(res.status).toBe(201);
    expect(res.body.data.product).toMatchObject({
      name: 'Ultrasound Scanner X1',
      slug: 'ultrasound-scanner-x1',
      sku: 'US-X1',
      status: 'draft',
      priceTzs: 12500000,
      categoryName: 'Imaging',
    });
    const row = await db('products').first('created_by');
    expect(row.created_by).toBeTruthy();
  });

  test('the same name gets the next free slug; a taken SKU is a field error', async () => {
    await as(adminCookie).post('/api/office/products', valid());
    const second = await as(adminCookie).post('/api/office/products', valid({ sku: 'US-X2' }));
    expect(second.body.data.product.slug).toBe('ultrasound-scanner-x1-2');

    const dup = await as(adminCookie).post('/api/office/products', valid({ name: 'Other', sku: 'Us-X1' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SKU_TAKEN');
    expect(dup.body.error.details.sku).toBeDefined();
  });

  test('invalid input gives field errors', async () => {
    const res = await as(adminCookie).post('/api/office/products', {
      name: ' ',
      sku: 'bad sku!',
      categoryId: 999,
      priceTzs: 0,
    });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details).sort()).toEqual(['categoryId', 'name', 'priceTzs', 'sku']);
  });

  test('rejects cross-origin writes', async () => {
    const res = await request(app).post('/api/office/products').set('Cookie', adminCookie).send(valid());
    expect(res.status).toBe(403);
  });

  test('search, category and status filters', async () => {
    await as(adminCookie).post('/api/office/products', valid());
    await as(adminCookie).post(
      '/api/office/products',
      valid({ name: 'Pulse Monitor', sku: 'PM-1', categoryId: 2, isPublished: true }),
    );
    const archived = await as(adminCookie).post(
      '/api/office/products',
      valid({ name: 'Old Lamp', sku: 'OL-1', categoryId: 2 }),
    );
    await as(adminCookie).patch(`/api/office/products/${archived.body.data.product.id}`, { isArchived: true });

    const list = async (qs) => (await as(adminCookie).get(`/api/office/products?${qs}`)).body.data;
    expect((await list('')).total).toBe(3);
    expect((await list('q=pulse')).products.map((p) => p.sku)).toEqual(['PM-1']);
    expect((await list('q=pm-')).total).toBe(1);
    expect((await list('categoryId=2')).total).toBe(2);
    expect((await list('status=published')).products.map((p) => p.sku)).toEqual(['PM-1']);
    expect((await list('status=draft')).products.map((p) => p.sku)).toEqual(['US-X1']);
    expect((await list('status=archived')).products.map((p) => p.sku)).toEqual(['OL-1']);
    expect((await list('q=%25')).total).toBe(0);
    expect((await as(adminCookie).get('/api/office/products?status=nope')).status).toBe(400);
  });

  test('publish, unpublish, archive and restore; archived cannot be published', async () => {
    const { id } = (await as(adminCookie).post('/api/office/products', valid())).body.data.product;
    const url = `/api/office/products/${id}`;

    expect((await as(adminCookie).patch(url, { isPublished: true })).body.data.product.status).toBe('published');
    expect((await as(adminCookie).patch(url, { isArchived: true })).body.data.product).toMatchObject({
      status: 'archived',
      isPublished: false,
    });
    const blocked = await as(adminCookie).patch(url, { isPublished: true });
    expect(blocked.status).toBe(400);
    expect((await as(adminCookie).patch(url, { isArchived: false })).body.data.product.status).toBe('draft');
    expect((await as(adminCookie).patch(url, { name: 'Renamed', priceTzs: '1,000' })).body.data.product).toMatchObject({
      name: 'Renamed',
      slug: 'ultrasound-scanner-x1',
      priceTzs: 1000,
    });
  });

  test('stores the full design: brand, origin, specs, cost, stock, featured', async () => {
    const res = await as(adminCookie).post(
      '/api/office/products',
      valid({
        brand: 'Mindray',
        countryOfOrigin: 'China',
        costPriceTzs: '9,000,000',
        quantityInStock: 2,
        lowStockAt: 3,
        isFeatured: true,
        specs: [
          { label: 'Display', value: '12.1"' },
          { label: '', value: '' },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.product).toMatchObject({
      brand: 'Mindray',
      countryOfOrigin: 'China',
      costPriceTzs: 9000000,
      quantityInStock: 2,
      stockStatus: 'low_stock',
      isFeatured: true,
      specs: [{ label: 'Display', value: '12.1"' }],
      images: [],
    });
  });

  test('stock status is derived from quantity and the alert level', async () => {
    const make = async (quantityInStock, sku) =>
      (await as(adminCookie).post('/api/office/products', valid({ sku, quantityInStock, lowStockAt: 3 }))).body.data
        .product.stockStatus;
    expect(await make(0, 'S-0')).toBe('out_of_stock');
    expect(await make(3, 'S-3')).toBe('low_stock');
    expect(await make(4, 'S-4')).toBe('in_stock');
  });

  test('an empty SKU is generated; a quotation product needs no price', async () => {
    const res = await as(adminCookie).post(
      '/api/office/products',
      valid({ sku: '', priceTzs: '', requestQuotation: true }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.product.sku).toMatch(/^PSP-IMA-\d{5}$/);
    expect(res.body.data.product).toMatchObject({ priceTzs: null, requestQuotation: true });

    const noPrice = await as(adminCookie).post('/api/office/products', valid({ sku: 'NP-1', priceTzs: '' }));
    expect(noPrice.status).toBe(400);
    expect(noPrice.body.error.details.priceTzs).toBeDefined();

    const patch = await as(adminCookie).patch(`/api/office/products/${res.body.data.product.id}`, {
      requestQuotation: false,
    });
    expect(patch.status).toBe(400);
  });

  test('photos: upload, main image, reorder, remove, limits and type checks', async () => {
    const { id } = (await as(adminCookie).post('/api/office/products', valid())).body.data.product;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
    const upload = (files) => {
      const req = request(app)
        .post(`/api/office/products/${id}/images`)
        .set('Cookie', adminCookie)
        .set('Origin', ORIGIN);
      files.forEach(([buffer, name]) => req.attach('photos', buffer, name));
      return req;
    };

    const first = await upload([
      [png, 'front.png'],
      [jpg, 'angle.jpg'],
    ]);
    expect(first.status).toBe(201);
    const images = first.body.data.product.images;
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ isMain: true, sortOrder: 0 });
    expect(images[0].url).toMatch(/^\/uploads\/products\/[0-9a-f-]{36}\.png$/);
    expect(fs.existsSync(path.join(UPLOADS, 'products', path.basename(images[0].url)))).toBe(true);

    const served = await request(app).get(images[0].url);
    expect(served.status).toBe(200);
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');

    // A text file renamed to .jpg is refused, and nothing is stored.
    const fake = await upload([[Buffer.from('<?php echo 1; ?>'), 'shell.jpg']]);
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('BAD_FILE_TYPE');

    const order = await request(app)
      .put(`/api/office/products/${id}/images/order`)
      .set('Cookie', adminCookie)
      .set('Origin', ORIGIN)
      .send({ imageIds: [images[1].id, images[0].id] });
    expect(order.status).toBe(200);
    expect(order.body.data.product.images[0]).toMatchObject({ id: images[1].id, isMain: true });

    const removed = await request(app)
      .delete(`/api/office/products/${id}/images/${images[1].id}`)
      .set('Cookie', adminCookie)
      .set('Origin', ORIGIN);
    expect(removed.status).toBe(200);
    expect(removed.body.data.product.images).toHaveLength(1);
    expect(removed.body.data.product.images[0]).toMatchObject({ id: images[0].id, isMain: true });
    expect(fs.existsSync(path.join(UPLOADS, 'products', path.basename(images[1].url)))).toBe(false);

    const many = await upload(Array.from({ length: 8 }, (_, i) => [png, `p${i}.png`]));
    expect(many.status).toBe(400);
    expect(many.body.error.code).toBe('TOO_MANY_FILES');
  });

  test('stock tabs: filter and counts', async () => {
    const make = (sku, quantityInStock) =>
      as(adminCookie).post('/api/office/products', valid({ name: sku, sku, quantityInStock, lowStockAt: 3 }));
    await make('A-0', 0);
    await make('A-1', 1);
    await make('A-3', 3);
    await make('A-9', 9);
    await make('B-0', 0);

    const list = async (qs) => (await as(adminCookie).get(`/api/office/products?${qs}`)).body.data;
    const all = await list('');
    expect(all.counts).toEqual({ all: 5, in_stock: 1, low_stock: 2, out_of_stock: 2 });
    expect((await list('stock=low_stock')).products.map((p) => p.sku).sort()).toEqual(['A-1', 'A-3']);
    expect((await list('stock=out_of_stock')).total).toBe(2);
    // Counts ignore the stock tab itself but follow the search.
    const searched = await list('stock=in_stock&q=B-');
    expect(searched.total).toBe(0);
    expect(searched.counts).toEqual({ all: 1, in_stock: 0, low_stock: 0, out_of_stock: 1 });
    expect((await as(adminCookie).get('/api/office/products?stock=nope')).status).toBe(400);
  });

  test('only published, not archived products are live (query level)', async () => {
    await as(adminCookie).post('/api/office/products', valid({ isPublished: true }));
    await as(adminCookie).post('/api/office/products', valid({ name: 'Draft', sku: 'D-1' }));
    const live = await onlyLive(db('products as p')).select('p.sku');
    expect(live.map((r) => r.sku)).toEqual(['US-X1']);
  });

  test('unknown id is 404', async () => {
    expect((await as(adminCookie).get('/api/office/products/not-a-uuid')).status).toBe(404);
    expect((await as(adminCookie).get('/api/office/products/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});
