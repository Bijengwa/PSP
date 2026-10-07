// Forgot-password requests waiting for IT. A request is stored even when the
// email matches nobody (staff_id null), so IT can see possible probing.
exports.up = async function (knex) {
  await knex.schema.createTable('password_reset_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('email').notNullable();
    t.uuid('staff_id').references('id').inTable('staff_profiles');
    t.enu('status', ['pending', 'resolved', 'dismissed'], {
      useNative: true,
      enumName: 'password_reset_request_status',
    })
      .notNullable()
      .defaultTo('pending');
    t.string('requested_ip');
    t.uuid('resolved_by').references('id').inTable('staff_profiles');
    t.timestamp('resolved_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['status', 'created_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('password_reset_requests');
  await knex.raw('drop type if exists password_reset_request_status');
};
