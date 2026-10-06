const crypto = require('crypto');
const redis = require('../redis');

// Sessions live only in Redis. The raw session ID exists only in the cookie;
// Redis keys use its SHA-256 hash, so a Redis dump cannot be replayed as cookies.
// A session records who is logged in and nothing else: role, is_active and
// must_change_password are always read fresh from Postgres.
const IDLE_TTL_SECONDS = 8 * 60 * 60;
const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
const REFRESH_EVERY_MS = 60 * 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const hashId = (id) => crypto.createHash('sha256').update(id).digest('hex');
const sessionKey = (hash) => `psp:sess:${hash}`;
const staffKey = (staffId) => `psp:staff-sess:${staffId}`;

// Redis being unreachable must never let a request through: every failure
// becomes a 503 for the caller.
async function call(fn) {
  try {
    return await fn(redis.client);
  } catch (err) {
    throw Object.assign(new Error('Service temporarily unavailable'), { status: 503, expose: true, cause: err });
  }
}

// Sliding 8h expiry, never past the 12h absolute limit.
function ttlSeconds(session, now) {
  const remaining = Math.ceil((session.absoluteExpiresAt - now) / 1000);
  return Math.max(1, Math.min(IDLE_TTL_SECONDS, remaining));
}

function create({ staffId, ip, userAgent }) {
  const id = crypto.randomBytes(32).toString('base64url');
  const hash = hashId(id);
  const now = Date.now();
  const session = { staffId, createdAt: now, absoluteExpiresAt: now + ABSOLUTE_TTL_MS, refreshedAt: now, ip, userAgent };

  return call(async (client) => {
    await client
      .multi()
      .set(sessionKey(hash), JSON.stringify(session), { expiration: { type: 'EX', value: IDLE_TTL_SECONDS } })
      .sAdd(staffKey(staffId), hash)
      // No session outlives 12h, so the index set never needs to outlive the newest one.
      .expire(staffKey(staffId), ABSOLUTE_TTL_MS / 1000)
      .exec();
    return { id, session };
  });
}

// Returns the session, or null when it is missing, malformed or past its absolute limit.
function get(id) {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return Promise.resolve(null);

  return call(async (client) => {
    const raw = await client.get(sessionKey(hashId(id)));
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (Date.now() >= session.absoluteExpiresAt) {
      await destroyWith(client, id);
      return null;
    }
    return session;
  });
}

// Extends the idle expiry, at most once a minute so most requests cost one GET.
function touch(id, session) {
  const now = Date.now();
  if (now - session.refreshedAt < REFRESH_EVERY_MS) return Promise.resolve();

  const refreshed = { ...session, refreshedAt: now };
  return call((client) =>
    client.set(sessionKey(hashId(id)), JSON.stringify(refreshed), {
      expiration: { type: 'EX', value: ttlSeconds(refreshed, now) },
    }),
  );
}

async function destroyWith(client, id) {
  const hash = hashId(id);
  const raw = await client.getDel(sessionKey(hash));
  if (!raw) return null;
  const { staffId } = JSON.parse(raw);
  await client.sRem(staffKey(staffId), hash);
  return staffId;
}

// Deletes one session. Resolves to its staff ID, or null if there was none.
function destroy(id) {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return Promise.resolve(null);
  return call((client) => destroyWith(client, id));
}

// Ends every session of one staff member at once (deactivation, password reset,
// role change).
function destroyAllForStaff(staffId) {
  return call(async (client) => {
    const hashes = await client.sMembers(staffKey(staffId));
    await client.del([...hashes.map(sessionKey), staffKey(staffId)]);
  });
}

module.exports = { create, get, touch, destroy, destroyAllForStaff, ABSOLUTE_TTL_MS };
