// Product catalogue for the office (M5.1). Prices are whole Tanzanian shillings
// (TZS has no practical minor unit), stored as integers. There are no stock
// columns: Inventory stays locked until its own stage. Products are never
// deleted, only archived.
const CATEGORIES = [
  'Imaging',
  'Patient monitoring',
  'Laboratory',
  'Hospital furniture',
  'Respiratory',
  'Infusion',
  'Sterilization',
  'Dental',
];

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

exports.up = async function (knex) {
  await knex.schema.createTable('product_categories', (t) => {
    t.increments('id').primary();
    t.string('name').notNullable().unique();
    t.string('slug').notNullable().unique();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('products', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name').notNullable();
    t.string('slug').notNullable().unique();
    t.string('sku').notNullable().unique();
    t.integer('category_id').notNullable().references('id').inTable('product_categories');
    t.text('description').notNullable().defaultTo('');
    t.text('specs').notNullable().defaultTo('');
    t.bigInteger('price_tzs').notNullable();
    t.boolean('is_published').notNullable().defaultTo(false);
    t.boolean('is_archived').notNullable().defaultTo(false);
    t.uuid('created_by').notNullable().references('id').inTable('staff_profiles');
    t.timestamps(true, true);
    t.index(['category_id']);
    t.index(['is_published', 'is_archived']);
  });

  await knex.raw('alter table products add constraint products_price_positive check (price_tzs > 0)');
  // SKUs are stored uppercase so uniqueness does not depend on how it was typed.
  await knex.raw('alter table products add constraint products_sku_uppercase check (sku = upper(sku))');
  // A product is either live or archived, never both.
  await knex.raw(
    'alter table products add constraint products_not_published_and_archived check (not (is_published and is_archived))',
  );

  await knex('product_categories').insert(
    CATEGORIES.map((name, index) => ({ name, slug: slugify(name), sort_order: index + 1 })),
  );
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('products');
  await knex.schema.dropTableIfExists('product_categories');
};
