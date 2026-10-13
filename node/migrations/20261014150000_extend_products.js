// Add Product page (M5.3 full design): brand, origin, structured specs, optional
// price (quotation mode), cost price, stock numbers on the product, featured flag
// and photos. These are plain columns: the Inventory module and profit reports
// stay locked. `specs` changes from free text to a jsonb list of {label, value};
// existing text is converted line by line ("Label: value").
function parseSpecLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':');
      return at > 0
        ? { label: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
        : { label: line, value: '' };
    });
}

exports.up = async function (knex) {
  await knex.schema.alterTable('products', (t) => {
    t.string('brand');
    t.string('country_of_origin');
    t.bigInteger('cost_price_tzs');
    t.boolean('request_quotation').notNullable().defaultTo(false);
    t.integer('quantity_in_stock').notNullable().defaultTo(0);
    t.integer('low_stock_at').notNullable().defaultTo(3);
    t.boolean('is_featured').notNullable().defaultTo(false);
    t.jsonb('specs_list').notNullable().defaultTo('[]');
  });

  const rows = await knex('products').select('id', 'specs');
  for (const row of rows) {
    await knex('products')
      .where({ id: row.id })
      .update({ specs_list: JSON.stringify(parseSpecLines(row.specs)) });
  }
  await knex.schema.alterTable('products', (t) => t.dropColumn('specs'));
  await knex.raw('alter table products rename column specs_list to specs');

  // The price may be empty only when the product is shown as "Request a quotation".
  await knex.raw('alter table products alter column price_tzs drop not null');
  await knex.raw('alter table products drop constraint products_price_positive');
  await knex.raw(
    'alter table products add constraint products_price_rules check ' +
      '((price_tzs is null and request_quotation) or price_tzs > 0)',
  );
  await knex.raw('alter table products add constraint products_cost_price_positive check (cost_price_tzs is null or cost_price_tzs > 0)');
  await knex.raw('alter table products add constraint products_quantity_not_negative check (quantity_in_stock >= 0)');
  await knex.raw('alter table products add constraint products_low_stock_not_negative check (low_stock_at >= 0)');

  await knex.schema.createTable('product_images', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('product_id').notNullable().references('id').inTable('products');
    t.string('url').notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_main').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['product_id', 'sort_order']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('product_images');

  await knex.raw('alter table products drop constraint products_low_stock_not_negative');
  await knex.raw('alter table products drop constraint products_quantity_not_negative');
  await knex.raw('alter table products drop constraint products_cost_price_positive');
  await knex.raw('alter table products drop constraint products_price_rules');
  // Quotation products have no price; give them 1 TZS so the old rule can hold.
  await knex('products').whereNull('price_tzs').update({ price_tzs: 1 });
  await knex.raw('alter table products alter column price_tzs set not null');
  await knex.raw('alter table products add constraint products_price_positive check (price_tzs > 0)');

  await knex.schema.alterTable('products', (t) => t.text('specs_text').notNullable().defaultTo(''));
  const rows = await knex('products').select('id', 'specs');
  for (const row of rows) {
    const list = Array.isArray(row.specs) ? row.specs : [];
    await knex('products')
      .where({ id: row.id })
      .update({ specs_text: list.map((s) => (s.value ? `${s.label}: ${s.value}` : s.label)).join('\n') });
  }
  await knex.schema.alterTable('products', (t) => t.dropColumn('specs'));
  await knex.raw('alter table products rename column specs_text to specs');

  await knex.schema.alterTable('products', (t) => {
    t.dropColumn('brand');
    t.dropColumn('country_of_origin');
    t.dropColumn('cost_price_tzs');
    t.dropColumn('request_quotation');
    t.dropColumn('quantity_in_stock');
    t.dropColumn('low_stock_at');
    t.dropColumn('is_featured');
  });
};
