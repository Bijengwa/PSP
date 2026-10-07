const express = require('express');
const sessions = require('./session.store');
const { login, changePassword, toPublicStaff } = require('./auth.service');
const {
  httpError,
  readSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  requireSameOrigin,
  requireAuth,
} = require('./auth.middleware');

const INVALID_CREDENTIALS = 'Invalid email or password';

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

// Works without a valid session too, so a stale cookie can always be cleared.
router.post('/logout', async (req, res) => {
  const sessionId = readSessionCookie(req);
  clearSessionCookie(res);
  const staffId = sessionId ? await sessions.destroy(sessionId) : null;
  if (staffId) req.log.info({ event: 'auth.logged_out', staffId }, 'Logged out');
  res.json({ success: true, data: null });
});

module.exports = router;
