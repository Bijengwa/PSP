const crypto = require('crypto');
const redis = require('../redis');
const { httpError } = require('./auth.middleware');

// Short-lived counters in Redis, kept apart from session storage. Every attempt
// counts, successful or not. Windows are fixed: the expiry is set when the first
// attempt creates the counter and later attempts never extend it.
const LIMITS = {
  login: { windowSeconds: 15 * 60, ip: 10, email: 5 },
  forgot: { windowSeconds: 60 * 60, ip: 5, email: 3 },
  order: { windowSeconds: 60 * 60, ip: 10, phone: 5 },
};

// How each identity becomes part of a key. Phone numbers are hashed so Redis never
// holds a customer's number.
const KEY_PART = {
  ip: (ip) => ip || 'unknown',
  email: (email) => email.trim().toLowerCase(),
  phone: (phone) => crypto.createHash('sha256').update(phone).digest('hex'),
};

// INCR + EXPIRE NX + TTL in one MULTI, so a counter can never be left without an expiry.
async function hit(key, windowSeconds) {
  const [count, , ttl] = await redis.client.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec();
  return { count, retryAfter: ttl > 0 ? ttl : windowSeconds };
}

// Counts one attempt for each identity of the scope (IP and email, or IP and phone).
// Over the limit on any: 429 with Retry-After. Redis unreachable: 503, so an attacker
// cannot switch the limits off.
async function enforce(res, scope, identity) {
  const { windowSeconds, ...limits } = LIMITS[scope];

  let results;
  try {
    results = await Promise.all(
      Object.entries(limits).map(([kind, limit]) =>
        hit(`psp:rl:${scope}:${kind}:${KEY_PART[kind](identity[kind])}`, windowSeconds).then((r) => ({ ...r, limit })),
      ),
    );
  } catch (err) {
    throw Object.assign(new Error('Service temporarily unavailable'), { status: 503, expose: true, cause: err });
  }

  const exceeded = results.filter((r) => r.count > r.limit);
  if (exceeded.length) {
    res.set('Retry-After', String(Math.max(...exceeded.map((r) => r.retryAfter))));
    throw httpError(429, 'Too many attempts. Try again later.', 'RATE_LIMITED');
  }
}

module.exports = { LIMITS, enforce };
