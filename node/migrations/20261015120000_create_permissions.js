// Permissions (H4). A permission is a data row with a stable key; a role holds a set of
// them through role_permissions. The keys and the IT/Staff sets below are the role matrix
// the user approved in H3: IT holds everything, Staff holds everything except registering
// staff. Routes start checking these keys in H5.
const PERMISSIONS = [
  ['staff.view', 'List and view staff accounts'],
  ['staff.register', 'Register a new staff account'],
  ['staff.edit', 'Edit a staff name and phone'],
  ['staff.change_role', 'Change a staff role'],
  ['staff.deactivate', 'Deactivate or reactivate a staff account'],
  ['staff.reset_password', 'Set a temporary password for a staff account'],
  ['reset_requests.view', 'See the password reset queue'],
  ['reset_requests.manage', 'Dismiss a password reset request'],
  ['products.view', 'View products, including cost price'],
  ['products.create', 'Add products'],
  ['products.edit', 'Edit, publish and archive products and their images'],
  ['customers.view', 'View customers'],
  ['customers.create', 'Add customers'],
  ['customers.edit', 'Edit customers'],
  ['orders.view', 'View orders'],
  ['orders.create', 'Create orders'],
  ['orders.update', 'Change order status, payment and items'],
  ['orders.link', 'Link or unlink an order and a customer'],
  ['audit.view', 'View the audit log'],
];

const STAFF_EXCLUDED = ['staff.register'];

exports.up = async function (knex) {
  await knex.schema.createTable('permissions', (t) => {
    t.increments('id').primary();
    t.string('key').notNullable().unique();
    t.string('description');
  });

  await knex.schema.createTable('role_permissions', (t) => {
    t.integer('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.integer('permission_id').notNullable().references('id').inTable('permissions').onDelete('CASCADE');
    t.primary(['role_id', 'permission_id']);
  });

  const inserted = await knex('permissions')
    .insert(PERMISSIONS.map(([key, description]) => ({ key, description })))
    .returning(['id', 'key']);

  const grant = async (roleName, keys) => {
    const role = await knex('roles').where({ name: roleName }).first('id');
    if (!role) return;
    const rows = inserted.filter((p) => keys.includes(p.key)).map((p) => ({ role_id: role.id, permission_id: p.id }));
    if (rows.length) await knex('role_permissions').insert(rows);
  };
  const all = PERMISSIONS.map(([key]) => key);
  await grant('IT', all);
  await grant('staff', all.filter((key) => !STAFF_EXCLUDED.includes(key)));
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('role_permissions');
  await knex.schema.dropTableIfExists('permissions');
};
