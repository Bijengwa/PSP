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
  STAFF_STATUSES,
  STAFF_PAGE_SIZE,
  toPublicStaff,
} = require('./auth.service');
const {
  httpError,
  readSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  requireSameOrigin,
  requireAuth,
  requireRole,
} = require('./auth.middleware');

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
    } else {
      req.log.warn({ event: 'auth.login_failed', reason: 'locked', staffId: result.staffId }, 'Login refused: account locked');
    }
    throw httpError(423, ACCOUNT_LOCKED, 'ACCOUNT_LOCKED');
  }
  if (result.error) {
    req.log.warn({ event: 'auth.login_failed' }, 'Login failed');
    throw httpError(401, INVALID_CREDENTIALS);
  }

  setSessionCookie(res, result.sessionId);
  req.log.info({ event: 'auth.login_succeeded', staffId: result.staff.id }, 'Login succeeded');
  res.json({ success: true, data: { staff: result.staff } });
});

router.get('/me', requireAuth({ allowPendingPasswordChange: true }), (req, res) => {
  res.json({ success: true, data: { staff: toPublicStaff(req.staff) } });
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
  res.json({ success: true, data: { message: RESET_REQUESTED } });
});

// Works without a valid session too, so a stale cookie can always be cleared.
router.post('/logout', async (req, res) => {
  const sessionId = readSessionCookie(req);
  clearSessionCookie(res);
  const staffId = sessionId ? await sessions.destroy(sessionId) : null;
  if (staffId) req.log.info({ event: 'auth.logged_out', staffId }, 'Logged out');
  res.json({ success: true, data: null });
});

// "Log out of all devices": ends every session of the caller, this one included.
// Reachable while a temporary password is set, since it only ever logs out.
router.post('/logout-all', requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
  await sessions.destroyAllForStaff(req.staff.id);
  clearSessionCookie(res);
  req.log.info({ event: 'auth.logged_out_all', staffId: req.staff.id }, 'Logged out of all devices');
  res.json({ success: true, data: null });
});

// ---------- IT's side of password resets, mounted at /api/office ----------
// Admin only. The role is read from Postgres on every request by requireAuth.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(req, name) {
  if (!UUID_PATTERN.test(req.params[name])) throw httpError(404, 'Not found');
  return req.params[name];
}

const officeRouter = express.Router();
officeRouter.use(requireSameOrigin, requireAuth(), requireRole('admin'));

officeRouter.get('/reset-requests', async (req, res) => {
  const status = req.query.status ?? 'pending';
  if (!RESET_REQUEST_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of: ${RESET_REQUEST_STATUSES.join(', ')}`);
  }
  res.json({ success: true, data: await listResetRequests({ status }) });
});

officeRouter.post('/reset-requests/:id/dismiss', async (req, res) => {
  const id = uuidParam(req, 'id');
  const result = await dismissResetRequest({ id, dismissedBy: req.staff.id });
  if (result === 'not_found') throw httpError(404, 'Not found');
  if (result === 'not_pending') throw httpError(409, 'This request has already been handled', 'NOT_PENDING');

  req.log.info({ event: 'reset_request.dismissed', requestId: id, by: req.staff.id }, 'Reset request dismissed');
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

officeRouter.get('/staff', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const status = req.query.status || undefined;
  if (status && !STAFF_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of: ${STAFF_STATUSES.join(', ')}`);
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  res.json({ success: true, data: await listStaff({ q, status, page, limit: STAFF_PAGE_SIZE }) });
});

officeRouter.post('/staff', async (req, res) => {
  const parsed = parseRegistration(req.body);
  if (parsed.fields) {
    throw Object.assign(httpError(400, 'Check the highlighted fields.', 'VALIDATION_ERROR'), { details: parsed.fields });
  }

  const result = await registerStaff({ ...parsed.values, createdBy: req.staff.id });
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
  res.status(201).json({ success: true, data: { staff: result.staff } });
});

officeRouter.get('/staff/:id', async (req, res) => {
  const staff = await getStaff(uuidParam(req, 'id'));
  if (!staff) throw httpError(404, 'Not found');
  res.json({ success: true, data: { staff } });
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
    throw httpError(409, 'The last active admin cannot be deactivated.', 'LAST_ADMIN');
  }

  if (result.changed) {
    const event = isActive ? 'staff.reactivated' : 'staff.deactivated';
    req.log.info({ event, staffId, by: req.staff.id }, isActive ? 'Staff reactivated' : 'Staff deactivated');
  }
  res.json({ success: true, data: { staff: result.staff } });
}

// Name and phone, or the status on its own. Role changes are a separate step (M4.6).
officeRouter.patch('/staff/:id', async (req, res) => {
  const staffId = uuidParam(req, 'id');
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
  res.json({ success: true, data: { staff } });
});

officeRouter.post('/staff/:id/reset-password', async (req, res) => {
  const staffId = uuidParam(req, 'id');
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
  res.json({ success: true, data: { staff: result.staff, resolvedRequests: result.resolvedRequests } });
});

module.exports = router;
module.exports.officeRouter = officeRouter;
