// Staff accounts for the office side. Roles are data rows, so new roles need no
// schema change. gen_random_uuid() is built into Postgres 13+.
exports.up = async function (knex) {
  await knex.schema.createTable('roles', (t) => {
    t.increments('id').primary();
    t.string('name').notNullable().unique();
    t.string('description');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('staff_profiles', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('full_name').notNullable();
    t.string('email').notNullable().unique();
    t.string('phone_number');
    t.string('password_hash').notNullable();
    t.string('profile_picture_url');
    t.integer('role_id').notNullable().references('id').inTable('roles');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('must_change_password').notNullable().defaultTo(true);
    t.integer('failed_login_count').notNullable().defaultTo(0);
    t.timestamp('locked_until', { useTz: true });
    t.timestamp('last_login_at', { useTz: true });
    t.uuid('created_by').references('id').inTable('staff_profiles');
    t.timestamps(true, true);
  });

  // Emails are compared lowercase; the constraint stops a mixed-case duplicate.
  await knex.raw('alter table staff_profiles add constraint staff_profiles_email_lowercase check (email = lower(email))');
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('staff_profiles');
  await knex.schema.dropTableIfExists('roles');
};
