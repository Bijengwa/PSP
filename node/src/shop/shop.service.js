const db = require('../db');
const { onlyLive } = require('../products/products.service');

// Public catalogue (C2) and guest orders (C5). Every query here goes through `onlyLive`, and only the
// columns below are ever selected: no SKU, cost, stock numbers, created_by or
// draft/archived rows can reach the shop.
const SHOP_PAGE_SIZE = 12;
const SHOP_SORTS = ['newest', 'price_asc', 'price_desc', 'name'];

const SHOP_COLUMNS = [
  'p.id',
  'p.name',
  'p.slug',
  'p.brand',
  'p.price_tzs',
  'p.request_quotation',
  'c.name as category_name',
  'c.slug as category_slug',
  db.raw('p.quantity_in_stock > 0 as in_stock'),
  db.raw(
    '(select i.url from product_images i where i.product_id = p.id order by i.is_main desc, i.sort_order, i.created_at limit 1) as image_url',
  ),
];

// Quotation products show "Price on request", so their price never leaves the server.
const ORDER_BY = {
  newest: [{ column: 'p.created_at', order: 'desc' }, { column: 'p.id' }],
  price_asc: [{ column: 'shop_price', order: 'asc', nulls: 'last' }, { column: 'p.name' }, { column: 'p.id' }],
  price_desc: [{ column: 'shop_price', order: 'desc', nulls: 'last' }, { column: 'p.name' }, { column: 'p.id' }],
  name: [{ column: 'p.name' }, { column: 'p.id' }],
};

function liveQuery() {
  return onlyLive(db('products as p').join('product_categories as c', 'c.id', 'p.category_id'));
}

function toShopProduct(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    brand: row.brand ?? '',
    category: { name: row.category_name, slug: row.category_slug },
    priceTzs: row.request_quotation || row.price_tzs === null ? null : Number(row.price_tzs),
    requestQuotation: row.request_quotation,
    inStock: row.in_stock,
    imageUrl: row.image_url ?? null,
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

// Categories that have at least one live product, in the office's order.
async function listShopCategories() {
  const rows = await db('product_categories as c')
    .join(liveQuery().select('p.category_id').as('live'), 'live.category_id', 'c.id')
    .groupBy('c.id')
    .orderBy(['c.sort_order', 'c.id'])
    .select(
      'c.name',
      'c.slug',
      db.raw('count(*) as product_count'),
      // Main photo of the newest live product in the category that has one.
      db.raw(
        `(select i.url from product_images i join products p on p.id = i.product_id
          where p.category_id = c.id and p.is_published = true and p.is_archived = false
          order by p.created_at desc, p.id, i.is_main desc, i.sort_order, i.created_at limit 1) as image_url`,
      ),
    );
  return rows.map((row) => ({
    name: row.name,
    slug: row.slug,
    productCount: Number(row.product_count),
    imageUrl: row.image_url ?? null,
  }));
}

// Search by name, brand or SKU (the SKU is matched but never returned).
async function listShopProducts({ q, category, sort = 'newest', page = 1, limit = SHOP_PAGE_SIZE }) {
  const filters = (query) => {
    if (q) {
      const like = `%${escapeLike(q)}%`;
      query.where((b) => b.whereILike('p.name', like).orWhereILike('p.brand', like).orWhereILike('p.sku', like));
    }
    if (category) query.where('c.slug', category);
    return query;
  };

  const [rows, [{ count }]] = await Promise.all([
    filters(liveQuery())
      .select(
        ...SHOP_COLUMNS,
        db.raw('case when p.request_quotation then null else p.price_tzs end as shop_price'),
      )
      .orderBy(ORDER_BY[sort])
      .limit(limit)
      .offset((page - 1) * limit),
    filters(liveQuery()).count('* as count'),
  ]);

  return {
    total: Number(count),
    page,
    pageSize: limit,
    products: rows.map(toShopProduct),
  };
}

const RELATED_LIMIT = 4;

// One live product for its page (C3), or null when it is missing, a draft or
// archived. The page adds the SKU, description, specs and every photo; still no
// cost, stock number or created_by. Up to 4 live products from the same category
// come with it.
async function getShopProduct(slug) {
  const row = await liveQuery()
    .where('p.slug', slug)
    .first(...SHOP_COLUMNS, 'p.sku', 'p.description', 'p.specs', 'p.category_id');
  if (!row) return null;

  const [images, related] = await Promise.all([
    db('product_images')
      .where('product_id', row.id)
      .orderBy([{ column: 'is_main', order: 'desc' }, { column: 'sort_order' }, { column: 'created_at' }])
      .pluck('url'),
    liveQuery()
      .where('p.category_id', row.category_id)
      .whereNot('p.id', row.id)
      .select(...SHOP_COLUMNS)
      .orderBy(ORDER_BY.newest)
      .limit(RELATED_LIMIT),
  ]);

  return {
    product: {
      ...toShopProduct(row),
      sku: row.sku,
      description: row.description ?? '',
      specs: (Array.isArray(row.specs) ? row.specs : []).map((spec) => ({
        label: String(spec?.label ?? ''),
        value: String(spec?.value ?? ''),
      })),
      images,
    },
    related: related.map(toShopProduct),
  };
}

// Current details for the cart page (C4): the live products among `lines`, in the
// cart's order, each with its quantity. Drafts, archived and unknown ids are left
// out, so the page can flag them. Prices come only from the database.
async function getCartPrices(lines) {
  if (lines.length === 0) return [];
  const rows = await liveQuery()
    .whereIn('p.id', lines.map((line) => line.productId))
    .select(...SHOP_COLUMNS);
  const byId = new Map(rows.map((row) => [row.id, toShopProduct(row)]));
  return lines
    .filter((line) => byId.has(line.productId))
    .map((line) => ({ product: byId.get(line.productId), quantity: line.quantity }));
}

// Database errors can carry the failing row (the guest's name and phone) in their
// `detail`. Only the error code, table and constraint are kept, so nothing personal
// reaches the log.
function withoutRowData(err) {
  return Object.assign(new Error('Could not save the order'), {
    code: err.code,
    table: err.table,
    constraint: err.constraint,
  });
}

// Places a guest order from the shop (C5). `guest` holds the validated, normalised
// contact and delivery details; `lines` are unique { productId, quantity }. Every
// line is read again from the database inside one transaction (the rows are locked
// against edits until it commits), so names and prices only ever come from there.
// Returns { problems } with a code per refused line (UNAVAILABLE for unknown, draft
// or archived products, OUT_OF_STOCK), or { order } with its number and total.
// Quotation lines are saved without a price and left out of the total. Stock is not
// decreased: staff do that when they confirm the order.
async function createShopOrder(guest, lines) {
  try {
    return await db.transaction(async (trx) => {
      const rows = await trx('products')
        .whereIn('id', lines.map((line) => line.productId))
        .forShare()
        .select('id', 'name', 'sku', 'price_tzs', 'request_quotation', 'quantity_in_stock', 'is_published', 'is_archived');
      const byId = new Map(rows.map((row) => [row.id, row]));

      const problems = [];
      lines.forEach((line, index) => {
        const row = byId.get(line.productId);
        if (!row || !row.is_published || row.is_archived) {
          problems.push({ index, productId: line.productId, code: 'UNAVAILABLE' });
        } else if (row.quantity_in_stock <= 0) {
          problems.push({ index, productId: line.productId, code: 'OUT_OF_STOCK' });
        }
      });
      if (problems.length) return { problems };

      // BigInt: 50 lines of large prices can pass Number's safe range.
      const items = lines.map((line, index) => {
        const row = byId.get(line.productId);
        const unit = row.request_quotation || row.price_tzs === null ? null : BigInt(row.price_tzs);
        return {
          product_id: row.id,
          product_name: row.name,
          product_sku: row.sku,
          unit_price_tzs: unit === null ? null : String(unit),
          quantity: line.quantity,
          line_total_tzs: unit === null ? null : String(unit * BigInt(line.quantity)),
          sort_order: index,
        };
      });
      const total = items.reduce((sum, item) => sum + BigInt(item.line_total_tzs ?? 0), 0n);

      const [order] = await trx('orders')
        .insert({
          ...guest,
          source: 'shop',
          total_tzs: String(total),
          has_quotation_lines: items.some((item) => item.unit_price_tzs === null),
        })
        .returning(['id', 'order_number', 'total_tzs']);
      await trx('order_items').insert(items.map((item) => ({ ...item, order_id: order.id })));

      return { order: { orderNumber: order.order_number, totalTzs: Number(order.total_tzs) } };
    });
  } catch (err) {
    throw withoutRowData(err);
  }
}

module.exports = {
  SHOP_PAGE_SIZE,
  SHOP_SORTS,
  listShopCategories,
  listShopProducts,
  getShopProduct,
  getCartPrices,
  createShopOrder,
};
