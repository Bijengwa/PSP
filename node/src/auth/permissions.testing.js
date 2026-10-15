// Test helper. The suites truncate `roles` (which cascades to role_permissions) and then
// insert their own roles; this re-grants the approved H3 matrix to whichever of the
// roles `IT` and `staff` exist: IT holds every permission, Staff all but staff.register.
// The permissions table itself is not truncated, so the keys are read from it.
const db = require('../db');

const STAFF_EXCLUDED = ['staff.register'];

async function grantMatrix() {
  const permissions = await db('permissions').select('id', 'key');
  const roles = await db('roles').whereIn('name', ['IT', 'staff']).select('id', 'name');
  const rows = [];
  for (const role of roles) {
    for (const permission of permissions) {
      if (role.name === 'staff' && STAFF_EXCLUDED.includes(permission.key)) continue;
      rows.push({ role_id: role.id, permission_id: permission.id });
    }
  }
  if (rows.length) await db('role_permissions').insert(rows).onConflict().ignore();
}

module.exports = { grantMatrix };
