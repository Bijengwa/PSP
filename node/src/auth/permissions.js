const db = require('../db');

// Permission keys held by a role, read from Postgres on every call. Nothing here is
// cached, so a change to role_permissions applies to the very next request.
async function permissionKeysForRole(roleName, conn = db) {
  // No role means no permissions: callers fail closed instead of querying for nothing.
  if (typeof roleName !== 'string') return [];
  const rows = await conn('role_permissions as rp')
    .join('roles as r', 'r.id', 'rp.role_id')
    .join('permissions as p', 'p.id', 'rp.permission_id')
    .where('r.name', roleName)
    .orderBy('p.key')
    .select('p.key');
  return rows.map((row) => row.key);
}

// The keys of `roleName` that `actorRole` does not hold. Granting a role is allowed only
// when this is empty: nobody can hand out more permissions than they have themselves.
async function permissionsBeyond(actorRole, roleName, conn = db) {
  const held = new Set(await permissionKeysForRole(actorRole, conn));
  return (await permissionKeysForRole(roleName, conn)).filter((key) => !held.has(key));
}

module.exports = { permissionKeysForRole, permissionsBeyond };
