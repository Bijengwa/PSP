const express = require('express');
const sessions = require('./session.store');
const {
  RESET_REQUEST_STATUSES,
  login,
  changePassword,
  requestPasswordReset,
  listResetRequests,
  dismissResetRequest,
  resetStaffPassword,
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

  // A fresh login always gets a fresh session ID.
  const previous = readSessionCookie(req);
  if (previous) await sessions.destroy(previous);

  const result = await login({
    email: email.trim().toLowerCase(),
    password,
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
  });
  if (!result) {
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
