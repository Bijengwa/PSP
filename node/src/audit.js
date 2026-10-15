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

// ---------- Reading the log (the office Audit log page) ----------

const AUDIT_PAGE_SIZE = 25;
// The part of the type before the first dot: auth.login_failed -> auth.
const AUDIT_CATEGORIES = ['auth', 'staff', 'reset_request', 'product', 'customer', 'order'];

// Newest first. The actor's name comes from `staff_profiles`; the target's name from
// whichever table holds that id (staff, customer, product or order number). Ids are
// uuids, so at most one join matches. A deleted target shows no name.
async function listAuditLogs({ category, page = 1, limit = AUDIT_PAGE_SIZE } = {}) {
  const filter = (query) => {
    if (category) query.where('audit_logs.type', 'like', `${category}.%`);
    return query;
  };
  const [{ count }] = await filter(db('audit_logs')).count({ count: '*' });
  const rows = await filter(
    db('audit_logs')
      .leftJoin('staff_profiles as actor', 'actor.id', 'audit_logs.actor_id')
      .leftJoin('staff_profiles as target', 'target.id', 'audit_logs.target_id')
      .leftJoin('customers', 'customers.id', 'audit_logs.target_id')
      .leftJoin('products', 'products.id', 'audit_logs.target_id')
      .leftJoin('orders', 'orders.id', 'audit_logs.target_id'),
  )
    .select(
      'audit_logs.id',
      'audit_logs.type',
      'audit_logs.actor_id',
      'audit_logs.target_id',
      'audit_logs.ip',
      'audit_logs.meta',
      'audit_logs.created_at',
      'actor.full_name as actor_name',
      db.raw(
        'coalesce(target.full_name, customers.company_name, customers.full_name, products.name, orders.order_number) as target_name',
      ),
    )
    .orderBy([{ column: 'audit_logs.created_at', order: 'desc' }, { column: 'audit_logs.id', order: 'desc' }])
    .limit(limit)
    .offset((page - 1) * limit);

  return {
    events: rows.map((row) => ({
      id: String(row.id),
      type: row.type,
      actorId: row.actor_id,
      actorName: row.actor_name,
      targetId: row.target_id,
      targetName: row.target_name,
      ip: row.ip,
      meta: row.meta ?? {},
      createdAt: row.created_at,
    })),
    total: Number(count),
    page,
    pageSize: limit,
  };
}

// Called once when the API starts; the consumer runs inside the API process.
function startAuditConsumer() {
  return bus.startConsumer({ group: GROUP, handler: handleEvent });
}

module.exports = {
  audit,
  handleEvent,
  startAuditConsumer,
  cleanMeta,
  listAuditLogs,
  AUDIT_CATEGORIES,
  AUDIT_PAGE_SIZE,
  GROUP,
};
