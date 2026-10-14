// Shop orders (C5). An order is a snapshot: the guest's details, the delivery
// address and every line's name, SKU and unit price are copied in, so later product
// edits never change it. `customer_id` gets its foreign key when Customers exist
// (M6/M7.5). Status transition rules come with M7.1; here only the values are fixed.
// Quotation lines have no unit price and no line total, and are left out of `total_tzs`.
exports.up = async function (knex) {
  await knex.raw('create sequence order_number_seq');

  await knex.schema.createTable('orders', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('order_number')
      .notNullable()
      .unique()
      .defaultTo(knex.raw("'PSP-' || lpad(nextval('order_number_seq')::text, 6, '0')"));
    t.uuid('customer_id');
    t.string('guest_name', 100).notNullable();
    t.string('guest_phone', 20).notNullable();
    t.string('guest_email', 254);
    t.string('delivery_area', 100).notNullable();
    t.string('delivery_address', 200).notNullable();
    t.text('notes').notNullable().defaultTo('');
    t.string('status').notNullable().defaultTo('new');
    t.string('payment_status').notNullable().defaultTo('unpaid');
    t.string('source').notNullable();
    t.bigInteger('total_tzs').notNullable();
    t.boolean('has_quotation_lines').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['status', 'created_at']);
    t.index(['customer_id']);
  });

  await knex.raw(
    "alter table orders add constraint orders_status_values check (status in ('new', 'confirmed', 'delivered', 'closed', 'cancelled'))",
  );
  await knex.raw("alter table orders add constraint orders_payment_status_values check (payment_status in ('unpaid', 'paid'))");
  await knex.raw("alter table orders add constraint orders_source_values check (source in ('shop', 'staff'))");
  await knex.raw('alter table orders add constraint orders_total_not_negative check (total_tzs >= 0)');
  await knex.raw('alter sequence order_number_seq owned by orders.order_number');

  await knex.schema.createTable('order_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.uuid('product_id').notNullable().references('id').inTable('products');
    t.string('product_name').notNullable();
    t.string('product_sku').notNullable();
    t.bigInteger('unit_price_tzs');
    t.integer('quantity').notNullable();
    t.bigInteger('line_total_tzs');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['order_id', 'sort_order']);
    t.index(['product_id']);
  });

  await knex.raw('alter table order_items add constraint order_items_quantity_positive check (quantity > 0)');
  await knex.raw(
    'alter table order_items add constraint order_items_prices_not_negative check ' +
      '((unit_price_tzs is null or unit_price_tzs >= 0) and (line_total_tzs is null or line_total_tzs >= 0))',
  );
  // A priced line has a line total; a quotation line has neither.
  await knex.raw(
    'alter table order_items add constraint order_items_line_total_rules check ' +
      '((unit_price_tzs is null) = (line_total_tzs is null))',
  );
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('order_items');
  await knex.schema.dropTableIfExists('orders');
  // Owned by orders.order_number, so normally already gone with the table.
  await knex.raw('drop sequence if exists order_number_seq');
};
