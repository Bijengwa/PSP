// The office has two roles for now: admin (seeded) and staff. Roles are data rows,
// so this only inserts the row; permissions come later (H3-H5).
exports.up = async function (knex) {
  await knex('roles')
    .insert({ name: 'staff', description: 'Normal office employee' })
    .onConflict('name')
    .ignore();
};

exports.down = async function (knex) {
  // Never delete a role that people still hold.
  const role = await knex('roles').where({ name: 'staff' }).first('id');
  if (!role) return;
  const inUse = await knex('staff_profiles').where({ role_id: role.id }).first('id');
  if (!inUse) await knex('roles').where({ id: role.id }).del();
};
