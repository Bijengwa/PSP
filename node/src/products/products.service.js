const crypto = require('crypto');
const db = require('../db');

const PRODUCT_STATUSES = ['draft', 'published', 'archived'];
const PRODUCT_PAGE_SIZE = 25;
const MAX_IMAGES = 8;

const PRODUCT_COLUMNS = [
  'p.id',
  'p.name',
  'p.slug',
  'p.sku',
  'p.category_id',
  'c.name as category_name',
  'p.brand',
  'p.country_of_origin',
  'p.description',
  'p.specs',
  'p.price_tzs',
  'p.cost_price_tzs',
  'p.request_quotation',
  'p.quantity_in_stock',
  'p.low_stock_at',
  'p.is_published',
  'p.is_featured',
  'p.is_archived',
  'p.created_at',
  'p.updated_at',
];

function productQuery() {
  return db('products as p').join('product_categories as c', 'c.id', 'p.category_id');
}

// A product is archived, live (published) or a draft; never two at once.
function statusOf(row) {
  if (row.is_archived) return 'archived';
  return row.is_published ? 'published' : 'draft';
}

// Derived, never stored: sales and restocks change the quantity, so this is always right.
function stockStatusOf(quantity, lowAt) {
  if (quantity <= 0) return 'out_of_stock';
  return quantity <= lowAt ? 'low_stock' : 'in_stock';
}

function toPublicProduct(row, images = []) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sku: row.sku,
    categoryId: row.category_id,
    categoryName: row.category_name,
    brand: row.brand ?? '',
    countryOfOrigin: row.country_of_origin ?? '',
    description: row.description,
    specs: Array.isArray(row.specs) ? row.specs : [],
    priceTzs: row.price_tzs === null ? null : Number(row.price_tzs),
    // Staff-only: this API is behind the office login. The public shop must never select it.
    costPriceTzs: row.cost_price_tzs === null ? null : Number(row.cost_price_tzs),
    requestQuotation: row.request_quotation,
    quantityInStock: row.quantity_in_stock,
    lowStockAt: row.low_stock_at,
    stockStatus: stockStatusOf(row.quantity_in_stock, row.low_stock_at),
    status: statusOf(row),
    isPublished: row.is_published,
    isFeatured: row.is_featured,
    isArchived: row.is_archived,
    images: images.map((image) => ({
      id: image.id,
      url: image.url,
      sortOrder: image.sort_order,
      isMain: image.is_main,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function withImages(rows) {
  if (rows.length === 0) return [];
  const images = await db('product_images')
    .whereIn(
      'product_id',
      rows.map((row) => row.id),
    )
    .orderBy([{ column: 'sort_order' }, { column: 'created_at' }]);
  const byProduct = new Map();
  for (const image of images) {
    if (!byProduct.has(image.product_id)) byProduct.set(image.product_id, []);
    byProduct.get(image.product_id).push(image);
  }
  return rows.map((row) => toPublicProduct(row, byProduct.get(row.id) ?? []));
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'product'
  );
}

// First free slug: "name", then "name-2", "name-3"...
async function uniqueSlug(name) {
  const base = slugify(name);
  const taken = new Set(
    (await db('products').where('slug', 'like', `${base}%`).select('slug')).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

// "PSP-IMA-48213": the category's first three letters and five digits.
async function generateSku(categoryId) {
  const category = await db('product_categories').where({ id: categoryId }).first('slug');
  const prefix = (category?.slug || 'gen').replace(/[^a-z]/g, '').slice(0, 3).toUpperCase() || 'GEN';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sku = `PSP-${prefix}-${String(crypto.randomInt(0, 100000)).padStart(5, '0')}`;
    if (!(await db('products').where({ sku }).first('id'))) return sku;
  }
  throw new Error('Could not generate a unique SKU');
}

async function listCategories() {
  const rows = await db('product_categories').orderBy('sort_order').select('id', 'name', 'slug');
  return rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug }));
}

async function categoryExists(id) {
  return Boolean(await db('product_categories').where({ id }).first('id'));
}

// The condition the public shop will use (M5.4): published and not archived.
function onlyLive(query) {
  return query.where('p.is_published', true).where('p.is_archived', false);
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

// Search by name, SKU or brand, filter by category and status, paged. `total`
// counts every match, not just the page.
async function listProducts({ q, categoryId, status, page = 1, limit = PRODUCT_PAGE_SIZE }) {
  const filters = (query) => {
    if (q) {
      const like = `%${escapeLike(q)}%`;
      query.where((b) =>
        b.whereILike('p.name', like).orWhereILike('p.sku', like).orWhereILike('p.brand', like),
      );
    }
    if (categoryId) query.where('p.category_id', categoryId);
    if (status === 'archived') query.where('p.is_archived', true);
    if (status === 'published') onlyLive(query);
    if (status === 'draft') query.where({ 'p.is_published': false, 'p.is_archived': false });
    return query;
  };

  const [rows, [{ count }]] = await Promise.all([
    filters(productQuery())
      .orderBy([{ column: 'p.created_at', order: 'desc' }, { column: 'p.id' }])
      .limit(limit)
      .offset((page - 1) * limit)
      .select(PRODUCT_COLUMNS),
    filters(productQuery()).count('* as count'),
  ]);

  return { total: Number(count), page, pageSize: limit, products: await withImages(rows) };
}

async function findProduct(id) {
  const row = await productQuery().where('p.id', id).first(PRODUCT_COLUMNS);
  return row ? (await withImages([row]))[0] : null;
}

const UNIQUE_VIOLATION = '23505';

function columnsFrom(values) {
  const map = {
    name: 'name',
    sku: 'sku',
    categoryId: 'category_id',
    brand: 'brand',
    countryOfOrigin: 'country_of_origin',
    description: 'description',
    priceTzs: 'price_tzs',
    costPriceTzs: 'cost_price_tzs',
    requestQuotation: 'request_quotation',
    quantityInStock: 'quantity_in_stock',
    lowStockAt: 'low_stock_at',
    isPublished: 'is_published',
    isFeatured: 'is_featured',
    isArchived: 'is_archived',
  };
  const columns = {};
  for (const [key, column] of Object.entries(map)) {
    if (key in values) columns[column] = values[key];
  }
  if ('specs' in values) columns.specs = JSON.stringify(values.specs);
  return columns;
}

// Returns { product } or { error: 'sku_taken' }. The slug comes from the name;
// a race on it retries with the next free one. An empty SKU is generated.
async function createProduct({ values, createdBy }) {
  const sku = values.sku || (await generateSku(values.categoryId));
  if (await db('products').where({ sku }).first('id')) return { error: 'sku_taken' };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = await uniqueSlug(values.name);
    try {
      const [row] = await db('products')
        .insert({
          ...columnsFrom({ description: '', ...values }),
          sku,
          slug,
          created_by: createdBy,
        })
        .returning('id');
      return { product: await findProduct(row.id) };
    } catch (err) {
      if (err.code !== UNIQUE_VIOLATION) throw err;
      if (String(err.constraint).includes('sku')) return { error: 'sku_taken' };
      // Otherwise the slug was taken by a parallel request: try the next one.
    }
  }
  throw new Error('Could not allocate a unique product slug');
}

// `changes` holds only the fields to change. Returns { product }, null when the
// product does not exist, or { error: 'sku_taken' }. The slug never changes, so
// shop links stay stable. Archiving also unpublishes.
async function updateProduct(id, changes) {
  const current = await db('products').where({ id }).first();
  if (!current) return null;

  const update = columnsFrom(changes);
  if (changes.isArchived) update.is_published = false;

  if (update.sku && update.sku !== current.sku && (await db('products').where({ sku: update.sku }).first('id'))) {
    return { error: 'sku_taken' };
  }

  try {
    await db('products')
      .where({ id })
      .update({ ...update, updated_at: db.fn.now() });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) return { error: 'sku_taken' };
    throw err;
  }
  return { product: await findProduct(id) };
}

// ---------- Images ----------

// Writes the rows for already-stored files. Returns { images } or
// { error: 'too_many' } when the product would pass MAX_IMAGES.
async function addImages(productId, urls) {
  return db.transaction(async (trx) => {
    // Locks the product row so two uploads cannot both slip under the limit.
    await trx('products').where({ id: productId }).forUpdate().first('id');
    const existing = await trx('product_images').where({ product_id: productId }).orderBy('sort_order');
    if (existing.length + urls.length > MAX_IMAGES) return { error: 'too_many' };

    const start = existing.length ? Math.max(...existing.map((image) => image.sort_order)) + 1 : 0;
    const rows = await trx('product_images')
      .insert(
        urls.map((url, index) => ({
          product_id: productId,
          url,
          sort_order: start + index,
          is_main: existing.length === 0 && index === 0,
        })),
      )
      .returning('*');
    return { images: rows };
  });
}

async function countImages(productId) {
  const [{ count }] = await db('product_images').where({ product_id: productId }).count('* as count');
  return Number(count);
}

// The first image by sort order is always the main one.
async function normalizeImages(productId, trx = db) {
  const images = await trx('product_images').where({ product_id: productId }).orderBy('sort_order').orderBy('created_at');
  for (const [index, image] of images.entries()) {
    if (image.sort_order !== index || image.is_main !== (index === 0)) {
      await trx('product_images')
        .where({ id: image.id })
        .update({ sort_order: index, is_main: index === 0, updated_at: db.fn.now() });
    }
  }
}

// Returns the removed row (so the caller can delete the file) or null.
async function removeImage(productId, imageId) {
  return db.transaction(async (trx) => {
    const image = await trx('product_images').where({ id: imageId, product_id: productId }).first();
    if (!image) return null;
    await trx('product_images').where({ id: imageId }).del();
    await normalizeImages(productId, trx);
    return image;
  });
}

// `orderedIds` must be exactly the product's image ids. Returns false otherwise.
async function reorderImages(productId, orderedIds) {
  return db.transaction(async (trx) => {
    const images = await trx('product_images').where({ product_id: productId });
    const known = new Set(images.map((image) => image.id));
    if (orderedIds.length !== known.size || !orderedIds.every((id) => known.has(id)) || new Set(orderedIds).size !== known.size) {
      return false;
    }
    for (const [index, id] of orderedIds.entries()) {
      await trx('product_images')
        .where({ id })
        .update({ sort_order: index, is_main: index === 0, updated_at: db.fn.now() });
    }
    return true;
  });
}

module.exports = {
  PRODUCT_STATUSES,
  PRODUCT_PAGE_SIZE,
  MAX_IMAGES,
  listCategories,
  categoryExists,
  listProducts,
  findProduct,
  createProduct,
  updateProduct,
  addImages,
  countImages,
  removeImage,
  reorderImages,
  onlyLive,
};
