const db = require('../db');
const sessions = require('./session.store');
const { hashPassword, verifyPassword, verifyAgainstDummy, passwordProblems } = require('./password');
const { permissionKeysForRole, permissionsBeyond } = require('./permissions');

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

// The signed-in person as the frontend sees them: the public profile plus the permission
// keys of their role, read from Postgres now.
async function toSessionStaff(staff) {
  return { ...toPublicStaff(staff), permissions: await permissionKeysForRole(staff.role) };
}

// Failed-login protection (auth spec §7): the 5th wrong password in a row locks
// the account for 15 minutes.
const LOCKOUT = { maxFailures: 5, minutes: 15 };

// Counts one wrong password in a single UPDATE, so parallel attempts cannot
// lose a count. Reaching the limit sets locked_until and starts the count again,
// so after the lock ends the person gets a full 5 attempts. Returns true when
// this failure locked the account.
async function recordFailedLogin(staffId) {
  const reachesLimit = db.raw('failed_login_count + 1 >= ?', [LOCKOUT.maxFailures]);
  const [row] = await db('staff_profiles')
    .where({ id: staffId })
    .update({
      failed_login_count: db.raw('case when ? then 0 else failed_login_count + 1 end', [reachesLimit]),
      locked_until: db.raw(`case when ? then now() + make_interval(mins => ?) else locked_until end`, [
        reachesLimit,
        LOCKOUT.minutes,
      ]),
    })
    .returning(['failed_login_count', 'locked_until']);
  return row.failed_login_count === 0 && row.locked_until !== null;
}

// Returns { sessionId, staff } on success, { error: 'locked' } while the account
// is locked (or when this attempt locked it), and { error: 'invalid' } for any
// other failure. Unknown emails, inactive accounts and locked accounts still pay
// for a password check, so the timing does not tell the cases apart. A locked
// account answers the same whether the password was right or wrong, and attempts
// made while locked do not extend the lock.
async function login({ email, password, ip, userAgent }) {
  const staff = await staffQuery()
    .where('s.email', email)
    .first([...PROFILE_COLUMNS, 's.password_hash', db.raw('(s.locked_until > now()) as is_locked')]);

  if (!staff || !staff.is_active) {
    await verifyAgainstDummy(password);
    return { error: 'invalid' };
  }
  if (staff.is_locked) {
    await verifyAgainstDummy(password);
    return { error: 'locked', staffId: staff.id };
  }
  if (!(await verifyPassword(staff.password_hash, password))) {
    const locked = await recordFailedLogin(staff.id);
    return locked ? { error: 'locked', staffId: staff.id, justLocked: true } : { error: 'invalid' };
  }

  const { id } = await sessions.create({ staffId: staff.id, ip, userAgent });
  await db('staff_profiles')
    .where({ id: staff.id })
    .update({ last_login_at: db.fn.now(), failed_login_count: 0, locked_until: null });
  return { sessionId: id, staff: await toSessionStaff(staff) };
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
  return { sessionId: id, staff: await toSessionStaff({ ...staff, must_change_password: false }) };
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
      .update({
        password_hash: passwordHash,
        must_change_password: true,
        failed_login_count: 0,
        locked_until: null,
        updated_at: trx.fn.now(),
      });
    return trx('password_reset_requests')
      .where({ staff_id: staff.id, status: 'pending' })
      .update({ status: 'resolved', resolved_by: resetBy, resolved_at: trx.fn.now() });
  });
  await sessions.destroyAllForStaff(staff.id);
  return { staff: toPublicStaff({ ...staff, must_change_password: true }), resolvedRequests };
}

const REGISTRABLE_ROLES = ['IT', 'staff'];

// IT registers someone with a temporary password. Returns { staff }, or
// { error: 'weak', problems }, { error: 'email_taken' }, { error: 'role' } or
// { error: 'beyond', keys } when the role holds permissions the registrar lacks.
// The person must choose their own password at first login. The password is
// hashed here and never logged or returned.
async function registerStaff({ fullName, email, phone, role, temporaryPassword, createdBy, actorRole }) {
  const roleRow = REGISTRABLE_ROLES.includes(role) ? await db('roles').where({ name: role }).first('id') : null;
  if (!roleRow) return { error: 'role' };
  const beyond = await permissionsBeyond(actorRole, role);
  if (beyond.length) return { error: 'beyond', keys: beyond };

  const problems = passwordProblems(temporaryPassword, { email, fullName });
  if (problems.length) return { error: 'weak', problems };

  if (await db('staff_profiles').where({ email }).first('id')) return { error: 'email_taken' };

  const passwordHash = await hashPassword(temporaryPassword);
  let row;
  try {
    [row] = await db('staff_profiles')
      .insert({
        full_name: fullName,
        email,
        phone_number: phone,
        password_hash: passwordHash,
        role_id: roleRow.id,
        must_change_password: true,
        created_by: createdBy,
      })
      .returning(['id', 'created_at']);
  } catch (err) {
    // Two registrations of the same email racing past the check above.
    if (err.code === '23505') return { error: 'email_taken' };
    throw err;
  }

  return {
    staff: {
      id: row.id,
      fullName,
      email,
      phone,
      role,
      isActive: true,
      mustChangePassword: true,
      createdAt: row.created_at,
    },
  };
}

const STAFF_STATUSES = ['active', 'inactive'];
const STAFF_PAGE_SIZE = 25;

// What IT sees about a person, in the list and on the profile. Never the password hash.
const STAFF_DETAIL_COLUMNS = [
  's.id',
  's.full_name',
  's.email',
  's.phone_number',
  's.is_active',
  's.must_change_password',
  's.last_login_at',
  's.created_at',
  'r.name as role',
];

function toStaffDetail(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone_number,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

// One person's profile for IT, or null.
async function getStaff(id) {
  const row = await staffQuery().where('s.id', id).first(STAFF_DETAIL_COLUMNS);
  return row ? toStaffDetail(row) : null;
}

// IT corrects a person's name and/or phone. Returns the updated profile, or null
// when the person does not exist. Neither field affects sign-in, so sessions stay.
async function updateStaff(id, { fullName, phone }) {
  const changes = { updated_at: db.fn.now() };
  if (fullName !== undefined) changes.full_name = fullName;
  if (phone !== undefined) changes.phone_number = phone;
  const updated = await db('staff_profiles').where({ id }).update(changes);
  return updated ? getStaff(id) : null;
}

// IT deactivates or reactivates a person. Rows are never deleted. Returns { staff },
// null when the person does not exist, { error: 'self' } when an admin tries to
// deactivate themselves, or { error: 'last_admin' } for the last active admin.
// The active admins are locked in one order first, so two admins deactivating each
// other at once cannot leave none. A deactivated person's sessions end inside the
// transaction (Redis down means nothing changes) and again after it, so a login
// that raced the write cannot survive either.
async function setStaffActive(id, isActive, { actorId }) {
  if (!isActive && id === actorId) return { error: 'self' };

  const result = await db.transaction(async (trx) => {
    const activeAdmins = await trx('staff_profiles as s')
      .join('roles as r', 'r.id', 's.role_id')
      .where({ 'r.name': 'IT', 's.is_active': true })
      .orderBy('s.id')
      .forUpdate('s')
      .select('s.id');
    const target = await trx('staff_profiles as s')
      .join('roles as r', 'r.id', 's.role_id')
      .where('s.id', id)
      .forUpdate('s')
      .first('s.id', 's.is_active', 'r.name as role');
    if (!target) return null;

    if (!isActive) {
      if (target.role === 'IT' && target.is_active && activeAdmins.length <= 1) return { error: 'last_admin' };
      await sessions.destroyAllForStaff(id);
    }
    await trx('staff_profiles').where({ id }).update({ is_active: isActive, updated_at: trx.fn.now() });
    return { changed: target.is_active !== isActive };
  });
  if (!result || result.error) return result;

  if (!isActive) await sessions.destroyAllForStaff(id);
  return { staff: await getStaff(id), changed: result.changed };
}

// The roles IT can assign: the existing `roles` rows. New roles come with H3.
function listRoles() {
  return db('roles').orderBy('name').select('name', 'description');
}

// IT changes a person's role to one of the existing roles. Returns { staff, changed,
// from }, null when the person does not exist, { error: 'role' } for an unknown role,
// { error: 'self' } when an admin tries to remove their own admin role,
// { error: 'last_admin' } when the last active admin would be demoted, or
// { error: 'beyond', keys } when the new role holds permissions the actor lacks. Locks the
// active admins and then the target, as setStaffActive does, so two admins demoting
// each other at once cannot leave none. A changed role ends the person's sessions
// inside the transaction (Redis down means nothing changes) and again after it.
async function setStaffRole(id, role, { actorId, actorRole }) {
  const roleRow = await db('roles').where({ name: role }).first('id');
  if (!roleRow) return { error: 'role' };
  const beyond = await permissionsBeyond(actorRole, role);
  if (beyond.length) return { error: 'beyond', keys: beyond };

  const result = await db.transaction(async (trx) => {
    const activeAdmins = await trx('staff_profiles as s')
      .join('roles as r', 'r.id', 's.role_id')
      .where({ 'r.name': 'IT', 's.is_active': true })
      .orderBy('s.id')
      .forUpdate('s')
      .select('s.id');
    const target = await trx('staff_profiles as s')
      .join('roles as r', 'r.id', 's.role_id')
      .where('s.id', id)
      .forUpdate('s')
      .first('s.id', 's.is_active', 'r.name as role');
    if (!target) return null;
    if (target.role === role) return { changed: false, from: target.role };

    if (target.role === 'IT') {
      if (id === actorId) return { error: 'self' };
      if (target.is_active && activeAdmins.length <= 1) return { error: 'last_admin' };
    }
    await sessions.destroyAllForStaff(id);
    await trx('staff_profiles').where({ id }).update({ role_id: roleRow.id, updated_at: trx.fn.now() });
    return { changed: true, from: target.role };
  });
  if (!result || result.error) return result;

  if (result.changed) await sessions.destroyAllForStaff(id);
  return { staff: await getStaff(id), changed: result.changed, from: result.from };
}

// IT's staff list: search by name or email, optional status filter, paged.
// Never selects the password hash. `total` counts every match, not just the page.
async function listStaff({ q, status, page = 1, limit = STAFF_PAGE_SIZE }) {
  const filters = (query) => {
    if (q) {
      // Escape LIKE wildcards so a typed % or _ is matched literally.
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      query.where((b) => b.whereILike('s.full_name', like).orWhereILike('s.email', like));
    }
    if (status) query.where('s.is_active', status === 'active');
    return query;
  };

  const [rows, [{ count }]] = await Promise.all([
    filters(staffQuery())
      .orderBy([{ column: 's.full_name', order: 'asc' }, { column: 's.id' }])
      .limit(limit)
      .offset((page - 1) * limit)
      .select(STAFF_DETAIL_COLUMNS),
    filters(staffQuery()).count('* as count'),
  ]);

  return { total: Number(count), page, pageSize: limit, staff: rows.map(toStaffDetail) };
}

module.exports = {
  LOCKOUT,
  RESET_REQUEST_STATUSES,
  login,
  changePassword,
  requestPasswordReset,
  listResetRequests,
  dismissResetRequest,
  resetStaffPassword,
  registerStaff,
  REGISTRABLE_ROLES,
  listStaff,
  getStaff,
  updateStaff,
  setStaffActive,
  listRoles,
  setStaffRole,
  STAFF_STATUSES,
  STAFF_PAGE_SIZE,
  findStaffById,
  toPublicStaff,
  toSessionStaff,
};
