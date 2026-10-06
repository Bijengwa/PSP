const sessions = require('./session.store');
const { findStaffById } = require('./auth.service');

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const COOKIE_NAME = 'psp_sid';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code && { code }) });
}

function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=') || null;
  }
  return null;
}

function setSessionCookie(res, sessionId) {
  res.cookie(COOKIE_NAME, sessionId, { ...COOKIE_OPTIONS, maxAge: sessions.ABSOLUTE_TTL_MS });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
}

// Blocks cross-site form posts (CSRF): state-changing requests must come from
// the office web app's own origin. Works together with SameSite=Lax.
function requireSameOrigin(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin !== CLIENT_ORIGIN) {
    throw httpError(403, 'Forbidden');
  }
  next();
}

// Loads the session from Redis and the staff member from Postgres (1 GET + 1
// indexed read). Sets req.staff and req.sessionId. A missing, expired or revoked
// session, or an inactive account, gets 401; Redis being down gets 503.
// Until the staff member changes their temporary password, only routes created
// with { allowPendingPasswordChange: true } are reachable.
function requireAuth({ allowPendingPasswordChange = false } = {}) {
  return async function (req, res, next) {
    const sessionId = readSessionCookie(req);
    const session = sessionId && (await sessions.get(sessionId));
    if (!session) {
      if (sessionId) clearSessionCookie(res);
      throw httpError(401, 'Authentication required');
    }

    const staff = await findStaffById(session.staffId);
    if (!staff || !staff.is_active) {
      await sessions.destroy(sessionId);
      clearSessionCookie(res);
      throw httpError(401, 'Authentication required');
    }
    if (staff.must_change_password && !allowPendingPasswordChange) {
      throw httpError(403, 'You must change your password first', 'PASSWORD_CHANGE_REQUIRED');
    }

    await sessions.touch(sessionId, session);
    req.staff = staff;
    req.sessionId = sessionId;
    next();
  };
}

// Use after requireAuth. Roles are checked against the role just read from Postgres.
function requireRole(...roles) {
  return function (req, res, next) {
    if (!roles.includes(req.staff?.role)) throw httpError(403, 'Forbidden');
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  httpError,
  readSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  requireSameOrigin,
  requireAuth,
  requireRole,
};
