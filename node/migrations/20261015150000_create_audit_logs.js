// Audit log (H6). One row per event the bus delivers to the `audit` consumer group.
// `event_id` is the stream entry ID and is unique, so an event delivered twice is
// logged once. actor_id and target_id are plain uuids with no foreign key: the log
// must outlive and never block changes to the rows it describes.
exports.up = async function (knex) {
  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').primary();
    t.string('event_id').notNullable().unique();
    t.string('type').notNullable();
    t.uuid('actor_id');
    t.uuid('target_id');
    t.string('ip');
    t.jsonb('meta').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['created_at']);
    t.index(['type', 'created_at']);
    t.index(['actor_id']);
    t.index(['target_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('audit_logs');
};
