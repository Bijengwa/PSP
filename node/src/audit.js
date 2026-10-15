const db = require('./db');
const bus = require('./auth/event-bus');

// Shared audit helper (H6). Services call `audit(type, details, { actorId })`; the
// event goes through the bus and the `audit` consumer group writes it to audit_logs.
//
// details: { targetId, ip, ...anything else }. targetId and ip get their own columns;
// the rest is stored as `meta`. Never put a password, hash or session ID in details.
const GROUP = 'audit';

// Defence in depth: keys that look like credentials are dropped before storage.
const SECRET_KEY = /pass(word)?|hash|secret|token|session|cookie|authorization/i;

function cleanMeta(value, depth = 0) {
  if (Array.isArray(value)) return depth > 4 ? [] : value.map((item) => cleanMeta(item, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 4) return {};
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!SECRET_KEY.test(key)) out[key] = cleanMeta(inner, depth + 1);
    }
    return out;
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (value) => (typeof value === 'string' && UUID.test(value) ? value : null);

// Publishes an audit event. Never throws: a failed publish is logged by the bus.
function audit(type, details = {}, { actorId = null } = {}) {
  return bus.publish(type, details, { actorId });
}

// The handler of the `audit` consumer group. Idempotent: the stream entry ID is the
// unique event_id, so a second delivery of the same event inserts nothing.
async function handleEvent(event) {
  const { targetId, ip, ...meta } = event.payload || {};
  const occurred = new Date(event.occurredAt);
  await db('audit_logs')
    .insert({
      event_id: event.id,
      type: event.type,
      actor_id: asUuid(event.actorId),
      target_id: asUuid(targetId),
      ip: typeof ip === 'string' ? ip.slice(0, 64) : null,
      meta: JSON.stringify(cleanMeta(meta)),
      created_at: Number.isNaN(occurred.getTime()) ? new Date() : occurred,
    })
    .onConflict('event_id')
    .ignore();
}

// Called once when the API starts; the consumer runs inside the API process.
function startAuditConsumer() {
  return bus.startConsumer({ group: GROUP, handler: handleEvent });
}

module.exports = { audit, handleEvent, startAuditConsumer, cleanMeta, GROUP };
