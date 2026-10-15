const express = require('express');
const sessions = require('./session.store');
const rateLimit = require('./rate-limit');
const {
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
  toSessionStaff,
} = require('./auth.service');
const {
  httpError,
  readSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  requireSameOrigin,
  requireAuth,
  requirePermission,
  assertPermission,
} = require('./auth.middleware');
const { permissionsBeyond } = require('./permissions');
const { audit, listAuditLogs, AUDIT_CATEGORIES } = require('../audit');

const INVALID_CREDENTIALS = 'Invalid email or password';
const ACCOUNT_LOCKED = 'Account temporarily locked. Try again later or contact IT.';
const RESET_REQUESTED = 'If this account exists, IT has been notified.';

const router = express.Router();
router.use(requireSameOrigin);

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    throw httpError(400, 'Email and password are required');
  }
  // Caps the work an attacker can force through argon2.
  if (email.length > 254 || password.length > 1024) {
    throw httpError(401, INVALID_CREDENTIALS);
  }

  await rateLimit.enforce(res, 'login', { ip: req.ip, email });

  // A fresh login always gets a fresh session ID.
  const previous = readSessionCookie(req);
  if (previous) await sessions.destroy(previous);

  const result = await login({
    email: email.trim().toLowerCase(),
    password,
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
  });
  if (result.error === 'locked') {
    if (result.justLocked) {
      req.log.warn({ event: 'auth.account_locked', staffId: result.staffId }, 'Account locked after failed logins');
      audit('auth.account_locked', { targetId: result.staffId, ip: req.ip });
    } else {
      req.log.warn({ event: 'auth.login_failed', reason: 'locked', staffId: result.staffId }, 'Login refused: account locked');
      audit('auth.login_failed', { targetId: result.staffId, ip: req.ip, reason: 'locked' });
    }
    throw httpError(423, ACCOUNT_LOCKED, 'ACCOUNT_LOCKED');
  }
  if (result.error) {
    req.log.warn({ event: 'auth.login_failed' }, 'Login failed');
    // The email as typed (never the password), so repeated guesses can be traced.
    audit('auth.login_failed', { ip: req.ip, email: email.trim().toLowerCase().slice(0, 254) });
    throw httpError(401, INVALID_CREDENTIALS);
  }

  setSessionCookie(res, result.sessionId);
  req.log.info({ event: 'auth.login_succeeded', staffId: result.staff.id }, 'Login succeeded');
  audit('auth.login_succeeded', { targetId: result.staff.id, ip: req.ip }, { actorId: result.staff.id });
  res.json({ success: true, data: { staff: result.staff } });
});

router.get('/me', requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
  res.json({ success: true, data: { staff: await toSessionStaff(req.staff) } });
});

// Reachable while a temporary password is set, so the person can replace it.
router.post('/change-password', requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
    throw httpError(400, 'Current and new password are required');
  }
  // Caps the work an attacker can force through argon2.
  if (currentPassword.length > 1024) {
    throw httpError(400, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
  }

  const result = await changePassword({
    staff: req.staff,
    currentPassword,
    newPassword,
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
  });
  // 400, not 401: a wrong current password must not look like a lost session.
  if (result.error === 'current') {
    throw httpError(400, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
  }
  if (result.error === 'weak') {
    throw Object.assign(httpError(400, 'The new password does not meet the rules', 'WEAK_PASSWORD'), {
      details: result.problems,
    });
  }

  setSessionCookie(res, result.sessionId);
  req.log.info({ event: 'auth.password_changed', staffId: result.staff.id }, 'Password changed');
  audit('auth.password_changed', { targetId: result.staff.id, ip: req.ip }, { actorId: result.staff.id });
  res.json({ success: true, data: { staff: result.staff } });
});

// The answer is the same whether or not the email belongs to someone, so it
// cannot be used to find staff accounts. No email is sent; IT works the queue.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body ?? {};
  if (typeof email !== 'string' || !email.trim() || email.length > 254) {
    throw httpError(400, 'Enter a valid email address');
  }

  await rateLimit.enforce(res, 'forgot', { ip: req.ip, email });

  await requestPasswordReset({ email, ip: req.ip });
  req.log.info({ event: 'reset_request.created' }, 'Password reset requested');
  audit('reset_request.created', { ip: req.ip });
  res.json({ success: true, data: { message: RESET_REQUESTED } });
});

// Works without a valid session too, so a stale cookie can always be cleared.
router.post('/logout', async (req, res) => {
  const sessionId = readSessionCookie(req);
  clearSessionCookie(res);
  const staffId = sessionId ? await sessions.destroy(sessionId) : null;
  if (staffId) {
    req.log.info({ event: 'auth.logged_out', staffId }, 'Logged out');
    audit('auth.logged_out', { targetId: staffId, ip: req.ip }, { actorId: staffId });
  }
  res.json({ success: true, data: null });
});

// "Log out of all devices": ends every session of the caller, this one included.
// Reachable while a temporary password is set, since it only ever logs out.
router.post('/logout-all', requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
  await sessions.destroyAllForStaff(req.staff.id);
  clearSessionCookie(res);
  req.log.info({ event: 'auth.logged_out_all', staffId: req.staff.id }, 'Logged out of all devices');
  audit('auth.logged_out_all', { targetId: req.staff.id, ip: req.ip }, { actorId: req.staff.id });
  res.json({ success: true, data: null });
});

// ---------- IT's side of password resets, mounted at /api/office ----------
// Each route needs its own permission key, read from Postgres on every request.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(req, name) {
  if (!UUID_PATTERN.test(req.params[name])) throw httpError(404, 'Not found');
  return req.params[name];
}

const officeRouter = express.Router();
officeRouter.use(requireSameOrigin, requireAuth());

// Nobody may act on an account whose role holds permissions they lack: that would let
// them sign in as that person (for example Staff resetting an IT password). Compared
// by permission, not by role name. 404 first, so unknown ids behave as before.
async function assertCanActOn(req, staffId) {
  const target = await getStaff(staffId);
  if (!target) throw httpError(404, 'Not found');
  if ((await permissionsBeyond(req.staff.role, target.role)).length) {
    throw httpError(403, 'You cannot change an account that holds more permissions than you.');
  }
}

officeRouter.get('/reset-requests', requirePermission('reset_requests.view'), async (req, res) => {
  const status = req.query.status ?? 'pending';
  if (!RESET_REQUEST_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of: ${RESET_REQUEST_STATUSES.join(', ')}`);
  }
  res.json({ success: true, data: await listResetRequests({ status }) });
});

officeRouter.post('/reset-requests/:id/dismiss', requirePermission('reset_requests.manage'), async (req, res) => {
  const id = uuidParam(req, 'id');
  const result = await dismissResetRequest({ id, dismissedBy: req.staff.id });
  if (result === 'not_found') throw httpError(404, 'Not found');
  if (result === 'not_pending') throw httpError(409, 'This request has already been handled', 'NOT_PENDING');

  req.log.info({ event: 'reset_request.dismissed', requestId: id, by: req.staff.id }, 'Reset request dismissed');
  audit('reset_request.dismissed', { targetId: id, ip: req.ip }, { actorId: req.staff.id });
  res.json({ success: true, data: null });
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,19}$/;

// Name and phone rules, shared by registration and profile edits.
// Each returns { value } or { error } (a message for the field).
function checkFullName(fullName) {
  const name = typeof fullName === 'string' ? fullName.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { error: 'Enter the full name.' };
  if (name.length > 120) return { error: 'Use at most 120 characters.' };
  return { value: name };
}

function checkPhone(phone) {
  const tel = typeof phone === 'string' ? phone.trim() : '';
  if (!tel) return { error: 'Enter a phone number.' };
  if (!PHONE_PATTERN.test(tel)) return { error: 'Enter a valid phone number, for example +255 700 000 000.' };
  return { value: tel };
}

// Validates the registration body. Returns { values } or { fields } (field -> message).
function parseRegistration(body) {
  const { fullName, email, phone, role, temporaryPassword } = body ?? {};
  const fields = {};
  const name = checkFullName(fullName);
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const tel = checkPhone(phone);

  if (name.error) fields.fullName = name.error;
  if (!mail) fields.email = 'Enter an email address.';
  else if (mail.length > 254 || !EMAIL_PATTERN.test(mail)) fields.email = 'Enter a valid email address.';
  if (tel.error) fields.phone = tel.error;
  if (!REGISTRABLE_ROLES.includes(role)) fields.role = 'Choose Admin or Staff.';
  if (typeof temporaryPassword !== 'string' || !temporaryPassword) {
    fields.temporaryPassword = 'Enter a temporary password.';
  } else if (temporaryPassword.length > 1024) {
    fields.temporaryPassword = 'Use at most 1024 characters.';
  }

  if (Object.keys(fields).length) return { fields };
  return { values: { fullName: name.value, email: mail, phone: tel.value, role, temporaryPassword } };
}

const EDITABLE_PROFILE_FIELDS = ['fullName', 'phone'];

// Validates a profile edit: only name and phone, at least one of them.
// Returns { values } or { fields } (field -> message).
function parseProfileEdit(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const keys = Object.keys(input);
  const other = keys.find((key) => !EDITABLE_PROFILE_FIELDS.includes(key));
  if (other) return { fields: { [other]: 'Only the full name and phone can be changed here.' } };
  if (!keys.length) return { fields: { fullName: 'Send the full name or phone to change.' } };

  const fields = {};
  const values = {};
  if ('fullName' in input) {
    const name = checkFullName(input.fullName);
    if (name.error) fields.fullName = name.error;
    else values.fullName = name.value;
  }
  if ('phone' in input) {
    const tel = checkPhone(input.phone);
    if (tel.error) fields.phone = tel.error;
    else values.phone = tel.value;
  }
  return Object.keys(fields).length ? { fields } : { values };
}

officeRouter.get('/staff', requirePermission('staff.view'), async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const status = req.query.status || undefined;
  if (status && !STAFF_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of: ${STAFF_STATUSES.join(', ')}`);
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  res.json({ success: true, data: await listStaff({ q, status, page, limit: STAFF_PAGE_SIZE }) });
});

officeRouter.post('/staff', requirePermission('staff.register'), async (req, res) => {
  const parsed = parseRegistration(req.body);
  if (parsed.fields) {
    throw Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: parsed.fields });
  }

  const result = await registerStaff({ ...parsed.values, createdBy: req.staff.id, actorRole: req.staff.role });
  if (result.error === 'beyond') throw httpError(403, 'You cannot give a role more permissions than you hold.');
  if (result.error === 'email_taken') {
    throw Object.assign(httpError(409, 'Someone is already registered with this email.', 'EMAIL_TAKEN'), {
      details: { email: 'This email is already registered.' },
    });
  }
  if (result.error === 'weak') {
    throw Object.assign(httpError(400, 'The temporary password does not meet the rules', 'WEAK_PASSWORD'), {
      details: result.problems,
    });
  }
  if (result.error) throw httpError(400, 'Choose Admin or Staff.', 'VALIDATION_ERROR');

  req.log.info(
    { event: 'staff.registered', staffId: result.staff.id, role: result.staff.role, by: req.staff.id },
    'Staff registered',
  );
  audit('staff.created', { targetId: result.staff.id, ip: req.ip, role: result.staff.role }, { actorId: req.staff.id });
  res.status(201).json({ success: true, data: { staff: result.staff } });
});

officeRouter.get('/staff/:id', requirePermission('staff.view'), async (req, res) => {
  const staff = await getStaff(uuidParam(req, 'id'));
  if (!staff) throw httpError(404, 'Not found');
  // canManage tells the profile page whether to offer the edit actions; the PATCH and
  // reset-password routes check the same rule (assertCanActOn) on every request.
  const canManage = (await permissionsBeyond(req.staff.role, staff.role)).length === 0;
  res.json({ success: true, data: { staff, canManage } });
});

// Deactivate or reactivate: { isActive } alone. Deactivation ends the person's
// sessions at once; the row is kept.
async function changeStatus(req, res, staffId, isActive) {
  const result = await setStaffActive(staffId, isActive, { actorId: req.staff.id });
  if (!result) throw httpError(404, 'Not found');
  if (result.error === 'self') {
    throw httpError(409, 'You cannot deactivate your own account.', 'CANNOT_DEACTIVATE_SELF');
  }
  if (result.error === 'last_admin') {
    throw httpError(409, 'The last active IT person cannot be deactivated.', 'LAST_ADMIN');
  }

  if (result.changed) {
    const event = isActive ? 'staff.reactivated' : 'staff.deactivated';
    req.log.info({ event, staffId, by: req.staff.id }, isActive ? 'Staff reactivated' : 'Staff deactivated');
    audit(event, { targetId: staffId, ip: req.ip }, { actorId: req.staff.id });
  }
  res.json({ success: true, data: { staff: result.staff } });
}

// Change the role: { role } alone, one of the existing roles. The person's sessions
// end, so they sign in again under the new role.
async function changeRole(req, res, staffId, role) {
  const result = await setStaffRole(staffId, role, { actorId: req.staff.id, actorRole: req.staff.role });
  if (!result) throw httpError(404, 'Not found');
  if (result.error === 'beyond') throw httpError(403, 'You cannot give a role more permissions than you hold.');
  if (result.error === 'role') {
    throw Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), {
      details: { role: 'Choose one of the existing roles.' },
    });
  }
  if (result.error === 'self') {
    throw httpError(409, 'You cannot remove your own IT role.', 'CANNOT_DEMOTE_SELF');
  }
  if (result.error === 'last_admin') {
    throw httpError(409, 'The last active IT person cannot be given another role.', 'LAST_ADMIN');
  }

  if (result.changed) {
    req.log.info(
      { event: 'staff.role_changed', staffId, from: result.from, to: role, by: req.staff.id },
      'Staff role changed',
    );
    audit(
      'staff.role_changed',
      { targetId: staffId, ip: req.ip, from: result.from, to: role },
      { actorId: req.staff.id },
    );
  }
  res.json({ success: true, data: { staff: result.staff } });
}

// The roles IT can assign on the staff profile.
officeRouter.get('/roles', requirePermission('staff.view'), async (req, res) => {
  res.json({ success: true, data: { roles: await listRoles() } });
});

// Name and phone, the status on its own, or the role on its own.
officeRouter.patch('/staff/:id', async (req, res) => {
  const staffId = uuidParam(req, 'id');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  await assertPermission(
    req,
    'role' in body ? 'staff.change_role' : 'isActive' in body ? 'staff.deactivate' : 'staff.edit',
  );
  await assertCanActOn(req, staffId);
  if (req.body && typeof req.body === 'object' && 'role' in req.body) {
    const keys = Object.keys(req.body);
    const fields = {};
    if (keys.length > 1) fields.role = 'Change the role on its own, without other fields.';
    else if (typeof req.body.role !== 'string' || !req.body.role) fields.role = 'Choose one of the existing roles.';
    if (fields.role) {
      throw Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: fields });
    }
    return changeRole(req, res, staffId, req.body.role);
  }
  if (req.body && typeof req.body === 'object' && 'isActive' in req.body) {
    const keys = Object.keys(req.body);
    const fields = {};
    if (keys.length > 1) fields.isActive = 'Change the status on its own, without other fields.';
    else if (typeof req.body.isActive !== 'boolean') fields.isActive = 'Send true to activate or false to deactivate.';
    if (fields.isActive) {
      throw Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: fields });
    }
    return changeStatus(req, res, staffId, req.body.isActive);
  }

  const parsed = parseProfileEdit(req.body);
  if (parsed.fields) {
    throw Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: parsed.fields });
  }

  const staff = await updateStaff(staffId, parsed.values);
  if (!staff) throw httpError(404, 'Not found');

  req.log.info(
    { event: 'staff.profile_updated', staffId, fields: Object.keys(parsed.values), by: req.staff.id },
    'Staff profile updated',
  );
  audit(
    'staff.updated',
    { targetId: staffId, ip: req.ip, fields: Object.keys(parsed.values) },
    { actorId: req.staff.id },
  );
  res.json({ success: true, data: { staff } });
});

officeRouter.post('/staff/:id/reset-password', requirePermission('staff.reset_password'), async (req, res) => {
  const staffId = uuidParam(req, 'id');
  await assertCanActOn(req, staffId);
  const { temporaryPassword } = req.body ?? {};
  if (typeof temporaryPassword !== 'string' || !temporaryPassword) {
    throw httpError(400, 'A temporary password is required');
  }

  const result = await resetStaffPassword({ staffId, temporaryPassword, resetBy: req.staff.id });
  if (!result) throw httpError(404, 'Not found');
  if (result.error === 'weak') {
    throw Object.assign(httpError(400, 'The temporary password does not meet the rules', 'WEAK_PASSWORD'), {
      details: result.problems,
    });
  }

  req.log.info(
    { event: 'staff.password_reset', staffId, by: req.staff.id, resolvedRequests: result.resolvedRequests },
    'Password reset by IT',
  );
  audit(
    'staff.password_reset',
    { targetId: staffId, ip: req.ip, resolvedRequests: result.resolvedRequests },
    { actorId: req.staff.id },
  );
  res.json({ success: true, data: { staff: result.staff, resolvedRequests: result.resolvedRequests } });
});

// The audit log (H7): read-only, newest first, optionally one category.
officeRouter.get('/audit-logs', requirePermission('audit.view'), async (req, res) => {
  const category = req.query.category || undefined;
  if (category && !AUDIT_CATEGORIES.includes(category)) {
    throw httpError(400, `category must be one of: ${AUDIT_CATEGORIES.join(', ')}`);
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  res.json({ success: true, data: await listAuditLogs({ category, page }) });
});

module.exports = router;
module.exports.officeRouter = officeRouter;
