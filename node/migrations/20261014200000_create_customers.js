// Customers (M6.1): the people and companies PSP sells to. Long-lived and edited any
// time, unlike orders, which copy the guest's details in. Phone and email are stored
// the way the shop checkout stores them on orders ("+255712345678", lowercase email),
// so a guest order can be matched to a customer with a plain indexed lookup (M7.5).
// Phone and email are not unique: a duplicate is a warning in the form (M6.3), not an
// error. `orders.customer_id` gets its foreign key with the orders work in M7.
exports.up = async function (knex) {
  await knex.schema.createTable('customers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('type').notNullable();
    t.string('full_name', 100);
    t.string('company_name', 150);
    t.string('tin', 20);
    t.string('contact_person', 100);
    t.string('phone', 20);
    t.string('email', 254);
    t.text('notes').notNullable().defaultTo('');
    t.uuid('created_by').notNullable().references('id').inTable('staff_profiles');
    t.timestamps(true, true);
    t.index(['phone']);
    t.index(['email']);
    t.index(['type', 'created_at']);
  });

  await knex.raw("alter table customers add constraint customers_type_values check (type in ('individual', 'company'))");
  // An individual is known by their name, a company by its company name.
  await knex.raw(
    'alter table customers add constraint customers_name_rules check ' +
      "((type = 'individual' and full_name is not null) or (type = 'company' and company_name is not null))",
  );
  // Company fields belong to companies only.
  await knex.raw(
    'alter table customers add constraint customers_company_fields check ' +
      "(type = 'company' or (company_name is null and tin is null and contact_person is null))",
  );
  // Emails are stored lowercase so matching does not depend on how it was typed.
  await knex.raw('alter table customers add constraint customers_email_lowercase check (email = lower(email))');

  await knex.schema.createTable('customer_addresses', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('label', 50).notNullable().defaultTo('');
    t.string('area', 100).notNullable();
    t.string('address', 200).notNullable();
    t.boolean('is_default').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['customer_id']);
  });

  // At most one default address per customer.
  await knex.raw(
    'create unique index customer_addresses_one_default on customer_addresses (customer_id) where is_default',
  );
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customer_addresses');
  await knex.schema.dropTableIfExists('customers');
};
