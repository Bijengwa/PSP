const redis = require('../redis');
const { logger } = require('../logger');

// Event bus on Redis Streams (auth spec §5). Services publish; consumer groups
// (audit, cache, it-notify) read with XREADGROUP and XACK once handled. Handlers
// must be idempotent: an event can be delivered more than once.
const STREAM = 'psp:events';
const DEAD_STREAM = 'psp:events:dead';
const MAX_LEN = 100000;
const CLAIM_IDLE_MS = 60 * 1000;
const MAX_DELIVERIES = 5;
const BATCH = 20;
const BLOCK_MS = 5000;
const RECLAIM_EVERY_MS = 30 * 1000;
const RETRY_PAUSE_MS = 2000;

// Never throws and never rejects: a failed publish is logged and the request
// carries on. Returns the stream entry ID, or null when the event was not published.
async function publish(type, payload = {}, { actorId = null } = {}) {
  try {
    return await redis.client.xAdd(
      STREAM,
      '*',
      {
        type,
        version: '1',
        occurredAt: new Date().toISOString(),
        actorId: actorId || '',
        payload: JSON.stringify(payload),
      },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: MAX_LEN } },
    );
  } catch (err) {
    // Only type and message: the payload may hold an email or IP.
    logger.error({ eventType: type, busError: err && err.message }, 'Event publish failed');
    return null;
  }
}

// Stream fields -> envelope { id, type, version, occurredAt, actorId, payload }.
function toEnvelope(id, fields) {
  let payload = {};
  try {
    payload = JSON.parse(fields.payload || '{}');
  } catch (err) {
    payload = {};
  }
  return {
    id,
    type: fields.type,
    version: Number(fields.version) || 1,
    occurredAt: fields.occurredAt,
    actorId: fields.actorId || null,
    payload,
  };
}

async function ensureGroup(client, group) {
  try {
    await client.xGroupCreate(STREAM, group, '0', { MKSTREAM: true });
  } catch (err) {
    if (!/BUSYGROUP/.test(err && err.message)) throw err;
  }
}

// Handles one entry and acknowledges it only when the handler succeeded.
async function deliver(client, group, handler, id, fields) {
  try {
    await handler(toEnvelope(id, fields));
    await client.xAck(STREAM, group, id);
  } catch (err) {
    // Left unacknowledged: it is claimed again after CLAIM_IDLE_MS.
    logger.error({ group, eventId: id, busError: err && err.message }, 'Event handler failed');
  }
}

// Claims entries a consumer received and never acknowledged. After MAX_DELIVERIES
// deliveries an entry goes to the dead-letter stream and is acknowledged.
async function reclaim(client, group, consumer, handler) {
  const pending = await client.xPendingRange(STREAM, group, '-', '+', BATCH, { IDLE: CLAIM_IDLE_MS });
  for (const entry of pending) {
    if (entry.deliveriesCounter >= MAX_DELIVERIES) {
      const [claimed] = (await client.xClaim(STREAM, group, consumer, 0, entry.id)) || [];
      if (claimed) {
        await client.xAdd(DEAD_STREAM, '*', { ...claimed.message, group, eventId: entry.id });
      }
      await client.xAck(STREAM, group, entry.id);
      logger.error({ group, eventId: entry.id }, 'Event moved to dead-letter stream');
      continue;
    }
    const claimedEntries = (await client.xClaim(STREAM, group, consumer, CLAIM_IDLE_MS, entry.id)) || [];
    for (const claimed of claimedEntries) {
      if (claimed) await deliver(client, group, handler, claimed.id, claimed.message);
      else await client.xAck(STREAM, group, entry.id); // trimmed away; nothing to handle
    }
  }
}

// One pass of a consumer: new entries first, then stale ones. Exported for tests.
async function pollOnce(client, { group, consumer, handler, block = BLOCK_MS }) {
  const options = { COUNT: BATCH };
  if (block > 0) options.BLOCK = block;
  const streams = await client.xReadGroup(group, consumer, { key: STREAM, id: '>' }, options);
  for (const stream of streams || []) {
    for (const message of stream.messages) {
      await deliver(client, group, handler, message.id, message.message);
    }
  }
}

const running = [];

// Starts a consumer loop on its own connection: a blocking read ties the connection up.
// The loop retries on failure, so Redis being down never crashes the API.
function startConsumer({ group, handler, consumer = `api-${process.pid}` }) {
  const client = redis.client.duplicate();
  client.on('error', () => {}); // state is reported by the main client
  const state = { stopped: false, client };
  running.push(state);

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

  (async () => {
    let lastReclaim = 0;
    while (!state.stopped) {
      try {
        if (!client.isOpen) await client.connect();
        await ensureGroup(client, group);
        if (Date.now() - lastReclaim >= RECLAIM_EVERY_MS) {
          lastReclaim = Date.now();
          await reclaim(client, group, consumer, handler);
        }
        await pollOnce(client, { group, consumer, handler });
      } catch (err) {
        if (state.stopped) break;
        logger.error({ group, busError: err && err.message }, 'Event consumer error');
        await pause(RETRY_PAUSE_MS);
      }
    }
  })();

  return state;
}

async function stopConsumers() {
  const states = running.splice(0);
  for (const state of states) state.stopped = true;
  await Promise.all(
    states.map(async (state) => {
      try {
        state.client.destroy(); // a blocked XREADGROUP cannot be closed gracefully
      } catch (err) {
        /* already closed */
      }
    }),
  );
}

module.exports = {
  STREAM,
  DEAD_STREAM,
  publish,
  toEnvelope,
  ensureGroup,
  pollOnce,
  reclaim,
  startConsumer,
  stopConsumers,
};
