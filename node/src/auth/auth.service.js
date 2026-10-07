const db = require('../db');
const sessions = require('./session.store');
const { hashPassword, verifyPassword, verifyAgainstDummy, passwordProblems } = require('./password');

const PROFILE_COLUMNS = [
  's.id',
  's.full_name',
  's.email',
  's.is_active',
  's.must_change_password',
  'r.name as role',
];

function staffQuery() {
  return db('staff_profiles as s').join('roles as r', 'r.id', 's.role_id');
}

// Staff profile and role come from Postgres on every request; they are never cached,
// so a deactivation or role change applies to the very next request.
function findStaffById(id) {
  return staffQuery().where('s.id', id).first(PROFILE_COLUMNS);
}

function toPublicStaff(staff) {
  return {
    id: staff.id,
    fullName: staff.full_name,
    email: staff.email,
    role: staff.role,
    mustChangePassword: staff.must_change_password,
  };
}

// Returns { sessionId, staff } on success and null on any failure. Unknown emails
// and inactive accounts still pay for a password check, so neither the response
// nor its timing reveals whether the email exists.
async function login({ email, password, ip, userAgent }) {
  const staff = await staffQuery().where('s.email', email).first([...PROFILE_COLUMNS, 's.password_hash']);

  if (!staff || !staff.is_active) {
    await verifyAgainstDummy(password);
    return null;
  }
  if (!(await verifyPassword(staff.password_hash, password))) {
    return null;
  }

  const { id } = await sessions.create({ staffId: staff.id, ip, userAgent });
  await db('staff_profiles').where({ id: staff.id }).update({ last_login_at: db.fn.now() });
  return { sessionId: id, staff: toPublicStaff(staff) };
}

// Returns { sessionId, staff } on success, { error: 'current' } for a wrong
// current password, or { error: 'weak', problems } when the new one breaks the
// rules. Every session of the person ends before the new password is stored, and
// the caller gets a fresh session, so a stolen session never survives a change.
async function changePassword({ staff, currentPassword, newPassword, ip, userAgent }) {
  const { password_hash: currentHash } = await db('staff_profiles').where({ id: staff.id }).first('password_hash');
  if (!(await verifyPassword(currentHash, currentPassword))) {
    return { error: 'current' };
  }

  const problems = passwordProblems(newPassword, { email: staff.email, fullName: staff.full_name });
  if (newPassword === currentPassword) problems.push('Choose a password different from the current one.');
  if (problems.length) return { error: 'weak', problems };

  const passwordHash = await hashPassword(newPassword);
  await sessions.destroyAllForStaff(staff.id);
  await db('staff_profiles')
    .where({ id: staff.id })
    .update({ password_hash: passwordHash, must_change_password: false, updated_at: db.fn.now() });
  const { id } = await sessions.create({ staffId: staff.id, ip, userAgent });
  return { sessionId: id, staff: toPublicStaff({ ...staff, must_change_password: false }) };
}

module.exports = { login, changePassword, findStaffById, toPublicStaff };
