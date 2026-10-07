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

// Stores a request for IT and returns nothing. Known and unknown emails take the
// same path (one lookup, one insert), so the caller cannot tell them apart.
async function requestPasswordReset({ email, ip }) {
  const staff = await db('staff_profiles').where({ email: email.trim().toLowerCase() }).first('id');
  await db('password_reset_requests').insert({ email, staff_id: staff?.id ?? null, requested_ip: ip });
}

const RESET_REQUEST_STATUSES = ['pending', 'resolved', 'dismissed'];
const RESET_QUEUE_LIMIT = 100;

// IT's queue, oldest first, with the matching staff member when there is one.
// `total` counts every request with that status, even past the page limit.
async function listResetRequests({ status }) {
  const [requests, [{ count }]] = await Promise.all([
    db('password_reset_requests as q')
      .leftJoin('staff_profiles as s', 's.id', 'q.staff_id')
      .where('q.status', status)
      .orderBy('q.created_at', 'asc')
      .limit(RESET_QUEUE_LIMIT)
      .select('q.id', 'q.email', 'q.status', 'q.created_at', 's.id as staff_id', 's.full_name', 's.is_active'),
    db('password_reset_requests').where({ status }).count('* as count'),
  ]);
  return {
    total: Number(count),
    requests: requests.map((row) => ({
      id: row.id,
      email: row.email,
      status: row.status,
      createdAt: row.created_at,
      staff: row.staff_id ? { id: row.staff_id, fullName: row.full_name, isActive: row.is_active } : null,
    })),
  };
}

// Returns 'dismissed', 'not_found', or 'not_pending'.
async function dismissResetRequest({ id, dismissedBy }) {
  const updated = await db('password_reset_requests')
    .where({ id, status: 'pending' })
    .update({ status: 'dismissed', resolved_by: dismissedBy, resolved_at: db.fn.now() });
  if (updated) return 'dismissed';
  return (await db('password_reset_requests').where({ id }).first('id')) ? 'not_pending' : 'not_found';
}

// IT sets a temporary password. Returns { staff, resolvedRequests }, null when
// the person does not exist, or { error: 'weak', problems }. The person must
// change it at next login, and every session they hold ends: once before the
// write (Redis down means nothing changes) and once after it, so a login with
// the old password that raced the write cannot survive either.
async function resetStaffPassword({ staffId, temporaryPassword, resetBy }) {
  const staff = await findStaffById(staffId);
  if (!staff) return null;

  const problems = passwordProblems(temporaryPassword, { email: staff.email, fullName: staff.full_name });
  if (problems.length) return { error: 'weak', problems };

  const passwordHash = await hashPassword(temporaryPassword);
  await sessions.destroyAllForStaff(staff.id);
  const resolvedRequests = await db.transaction(async (trx) => {
    await trx('staff_profiles')
      .where({ id: staff.id })
      .update({ password_hash: passwordHash, must_change_password: true, updated_at: trx.fn.now() });
    return trx('password_reset_requests')
      .where({ staff_id: staff.id, status: 'pending' })
      .update({ status: 'resolved', resolved_by: resetBy, resolved_at: trx.fn.now() });
  });
  await sessions.destroyAllForStaff(staff.id);
  return { staff: toPublicStaff({ ...staff, must_change_password: true }), resolvedRequests };
}

module.exports = {
  RESET_REQUEST_STATUSES,
  login,
  changePassword,
  requestPasswordReset,
  listResetRequests,
  dismissResetRequest,
  resetStaffPassword,
  findStaffById,
  toPublicStaff,
};
