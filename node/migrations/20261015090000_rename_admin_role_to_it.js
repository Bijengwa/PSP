// The office has two roles: IT and Staff (H3, decided by the user on 2026-10-15). The
// seeded `admin` role becomes `IT`. Roles are data rows and staff_profiles point at the
// row's id, so everyone who held `admin` keeps their access under the new name.
exports.up = async function (knex) {
  // A database that already has an `IT` row keeps it; nothing is merged or deleted.
  const existing = await knex('roles').where({ name: 'IT' }).first('id');
  if (existing) return;
  await knex('roles')
    .where({ name: 'admin' })
    .update({ name: 'IT', description: 'Full access to the office' });
};

exports.down = async function (knex) {
  const existing = await knex('roles').where({ name: 'admin' }).first('id');
  if (existing) return;
  await knex('roles').where({ name: 'IT' }).update({ name: 'admin' });
};
