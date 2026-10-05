exports.up = function (knex) {
  return knex.schema.createTable('system_info', (t) => {
    t.increments('id').primary();
    t.string('key').notNullable().unique();
    t.string('value');
    t.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('system_info');
};