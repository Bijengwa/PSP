const express = require('express');
const { httpError, requireSameOrigin, requireAuth, requirePermission } = require('../auth/auth.middleware');
const {
  PRODUCT_STATUSES,
  STOCK_FILTERS,
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
} = require('./products.service');
const { readPhotos, storePhotos, removeFile } = require('./products.images');

// Office product catalogue, mounted at /api/office/products. Every route needs a
// products.* permission, read from Postgres on each request.
const router = express.Router();
router.use(requireSameOrigin, requireAuth());

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]*$/;
const MAX_PRICE_TZS = 9_000_000_000_000;
const MAX_STOCK = 1_000_000;
const MAX_SPECS = 40;

function validationError(fields) {
  return Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: fields });
}

function skuTaken() {
  return Object.assign(httpError(409, 'A product with this SKU already exists.', 'SKU_TAKEN'), {
    details: { sku: 'This SKU is already used.' },
  });
}

// Whole numbers arrive as numbers or typed strings ("12,500,000"). Returns NaN for anything else.
function wholeNumber(raw) {
  const value = typeof raw === 'string' ? raw.replace(/[,\s]/g, '') : raw;
  if (value === '' || value === null || value === undefined) return NaN;
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) ? number : NaN;
}

const isBlank = (raw) => raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');

// Validates the fields that are present. With `partial`, absent fields are skipped
// (PATCH); otherwise the required ones must be there (POST). Rules that depend on
// other fields (price vs quotation) are checked by the caller.
// Returns { fields } with messages, or { values }.
async function parseProduct(body, { partial }) {
  const input = body && typeof body === 'object' ? body : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const fields = {};
  const values = {};

  if (!partial || has('name')) {
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) fields.name = 'Enter the product name.';
    else if (name.length > 160) fields.name = 'Use at most 160 characters.';
    else values.name = name;
  }

  // An empty SKU on create means "generate one".
  if (has('sku') && !(isBlank(input.sku) && !partial)) {
    const sku = typeof input.sku === 'string' ? input.sku.trim().toUpperCase() : '';
    if (!sku) fields.sku = 'Enter a SKU.';
    else if (sku.length > 64) fields.sku = 'Use at most 64 characters.';
    else if (!SKU_PATTERN.test(sku)) fields.sku = 'Use letters, digits, dots, dashes and underscores only.';
    else values.sku = sku;
  }

  if (!partial || has('categoryId')) {
    const categoryId = Number(input.categoryId);
    if (!Number.isInteger(categoryId) || categoryId < 1 || !(await categoryExists(categoryId))) {
      fields.categoryId = 'Choose a category.';
    } else {
      values.categoryId = categoryId;
    }
  }

  for (const [key, label, max] of [
    ['brand', 'brand', 120],
    ['countryOfOrigin', 'country', 80],
  ]) {
    if (has(key)) {
      if (isBlank(input[key])) values[key] = null;
      else if (typeof input[key] !== 'string') fields[key] = `Enter the ${label} as text.`;
      else if (input[key].trim().length > max) fields[key] = `Use at most ${max} characters.`;
      else values[key] = input[key].trim();
    }
  }

  if (has('description') || !partial) {
    const text = input.description === undefined || input.description === null ? '' : input.description;
    if (typeof text !== 'string') fields.description = 'Enter text.';
    else if (text.length > 10000) fields.description = 'Use at most 10,000 characters.';
    else values.description = text.trim();
  }

  if (has('specs')) {
    if (!Array.isArray(input.specs)) {
      fields.specs = 'Specifications must be a list.';
    } else {
      const rows = [];
      let problem = null;
      for (const row of input.specs) {
        const label = typeof row?.label === 'string' ? row.label.trim() : '';
        const value = typeof row?.value === 'string' ? row.value.trim() : '';
        if (!label && !value) continue; // blank rows are dropped
        if (!label || !value) problem = 'Fill in both the name and the value of each specification, or remove the row.';
        else if (label.length > 120 || value.length > 500) problem = 'A specification is too long.';
        else rows.push({ label, value });
      }
      if (problem) fields.specs = problem;
      else if (rows.length > MAX_SPECS) fields.specs = `Use at most ${MAX_SPECS} specifications.`;
      else values.specs = rows;
    }
  }

  if (has('priceTzs')) {
    if (isBlank(input.priceTzs)) {
      values.priceTzs = null; // allowed only in quotation mode, checked by the caller
    } else {
      const price = wholeNumber(input.priceTzs);
      if (!Number.isInteger(price) || price < 1) fields.priceTzs = 'Enter a price in whole TZS, greater than 0.';
      else if (price > MAX_PRICE_TZS) fields.priceTzs = 'This price is too large.';
      else values.priceTzs = price;
    }
  }

  if (has('costPriceTzs')) {
    if (isBlank(input.costPriceTzs)) {
      values.costPriceTzs = null;
    } else {
      const cost = wholeNumber(input.costPriceTzs);
      if (!Number.isInteger(cost) || cost < 1) fields.costPriceTzs = 'Enter a cost in whole TZS, greater than 0.';
      else if (cost > MAX_PRICE_TZS) fields.costPriceTzs = 'This cost is too large.';
      else values.costPriceTzs = cost;
    }
  }

  for (const [key, label] of [
    ['quantityInStock', 'a quantity'],
    ['lowStockAt', 'an alert level'],
  ]) {
    if (has(key)) {
      const number = wholeNumber(input[key]);
      if (!Number.isInteger(number) || number < 0 || number > MAX_STOCK) {
        fields[key] = `Enter ${label} of 0 or more.`;
      } else {
        values[key] = number;
      }
    }
  }

  for (const key of ['requestQuotation', 'isPublished', 'isFeatured', 'isArchived']) {
    if (has(key)) {
      if (typeof input[key] !== 'boolean') fields[key] = 'Must be true or false.';
      else values[key] = input[key];
    }
  }

  return Object.keys(fields).length ? { fields } : { values };
}

router.get('/categories', requirePermission('products.view'), async (req, res) => {
  res.json({ success: true, data: { categories: await listCategories() } });
});

router.get('/', requirePermission('products.view'), async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const status = req.query.status || undefined;
  if (status && !PRODUCT_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of: ${PRODUCT_STATUSES.join(', ')}`);
  }
  const stock = req.query.stock || undefined;
  if (stock && !STOCK_FILTERS.includes(stock)) {
    throw httpError(400, `stock must be one of: ${STOCK_FILTERS.join(', ')}`);
  }
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
  if (categoryId !== undefined && (!Number.isInteger(categoryId) || categoryId < 1)) {
    throw httpError(400, 'categoryId must be a positive whole number');
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  res.json({
    success: true,
    data: await listProducts({ q, categoryId, status, stock, page, limit: PRODUCT_PAGE_SIZE }),
  });
});

router.post('/', requirePermission('products.create'), async (req, res) => {
  const parsed = await parseProduct(req.body, { partial: false });
  if (parsed.fields) throw validationError(parsed.fields);

  const values = {
    brand: null,
    countryOfOrigin: null,
    specs: [],
    priceTzs: null,
    costPriceTzs: null,
    requestQuotation: false,
    quantityInStock: 0,
    lowStockAt: 3,
    isPublished: false,
    isFeatured: false,
    ...parsed.values,
  };
  if (!values.requestQuotation && values.priceTzs === null) {
    throw validationError({ priceTzs: 'Enter a price in whole TZS, greater than 0.' });
  }
  if (values.requestQuotation) values.priceTzs = values.priceTzs ?? null;

  const result = await createProduct({ values, createdBy: req.staff.id });
  if (result.error === 'sku_taken') throw skuTaken();

  req.log.info({ event: 'product.created', productId: result.product.id, by: req.staff.id }, 'Product created');
  res.status(201).json({ success: true, data: { product: result.product } });
});

function idParam(req) {
  if (!UUID_PATTERN.test(req.params.id)) throw httpError(404, 'Not found');
  return req.params.id;
}

router.get('/:id', requirePermission('products.view'), async (req, res) => {
  const product = await findProduct(idParam(req));
  if (!product) throw httpError(404, 'Not found');
  res.json({ success: true, data: { product } });
});

router.patch('/:id', requirePermission('products.edit'), async (req, res) => {
  const id = idParam(req);
  const parsed = await parseProduct(req.body, { partial: true });
  if (parsed.fields) throw validationError(parsed.fields);
  if (Object.keys(parsed.values).length === 0) throw httpError(400, 'Nothing to change.');

  const current = await findProduct(id);
  if (!current) throw httpError(404, 'Not found');
  const { values } = parsed;

  // An archived product must be restored before it can go live again.
  if (values.isPublished === true && (values.isArchived === true || (values.isArchived === undefined && current.isArchived))) {
    throw validationError({ isPublished: 'Restore the product before publishing it.' });
  }
  // A price is needed unless the product is shown as "Request a quotation".
  const quotation = values.requestQuotation ?? current.requestQuotation;
  const price = 'priceTzs' in values ? values.priceTzs : current.priceTzs;
  if (!quotation && price === null) {
    throw validationError({ priceTzs: 'Enter a price in whole TZS, greater than 0.' });
  }

  const result = await updateProduct(id, values);
  if (!result) throw httpError(404, 'Not found');
  if (result.error === 'sku_taken') throw skuTaken();

  req.log.info({ event: 'product.updated', productId: id, by: req.staff.id }, 'Product updated');
  res.json({ success: true, data: { product: result.product } });
});

// ---------- Photos ----------

router.post('/:id/images', requirePermission('products.edit'), readPhotos, async (req, res) => {
  const id = idParam(req);
  const product = await findProduct(id);
  if (!product) throw httpError(404, 'Not found');

  const incoming = req.files?.length ?? 0;
  if ((await countImages(id)) + incoming > MAX_IMAGES) {
    throw httpError(400, `A product can have up to ${MAX_IMAGES} photos.`, 'TOO_MANY_FILES');
  }

  const urls = await storePhotos(req.files);
  const result = await addImages(id, urls);
  if (result.error) {
    await Promise.all(urls.map(removeFile));
    throw httpError(400, `A product can have up to ${MAX_IMAGES} photos.`, 'TOO_MANY_FILES');
  }

  req.log.info({ event: 'product.images_added', productId: id, count: urls.length, by: req.staff.id }, 'Photos added');
  res.status(201).json({ success: true, data: { product: await findProduct(id) } });
});

router.put('/:id/images/order', requirePermission('products.edit'), async (req, res) => {
  const id = idParam(req);
  const order = req.body?.imageIds;
  if (!Array.isArray(order) || !order.every((value) => typeof value === 'string' && UUID_PATTERN.test(value))) {
    throw httpError(400, 'imageIds must be a list of photo ids.');
  }
  if (!(await findProduct(id))) throw httpError(404, 'Not found');
  if (!(await reorderImages(id, order))) {
    throw httpError(400, 'imageIds must list every photo of the product exactly once.');
  }
  res.json({ success: true, data: { product: await findProduct(id) } });
});

router.delete('/:id/images/:imageId', requirePermission('products.edit'), async (req, res) => {
  const id = idParam(req);
  if (!UUID_PATTERN.test(req.params.imageId)) throw httpError(404, 'Not found');
  const removed = await removeImage(id, req.params.imageId);
  if (!removed) throw httpError(404, 'Not found');
  await removeFile(removed.url);

  req.log.info({ event: 'product.image_removed', productId: id, by: req.staff.id }, 'Photo removed');
  res.json({ success: true, data: { product: await findProduct(id) } });
});

module.exports = router;
