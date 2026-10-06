const { createClient } = require('redis');
const { logger } = require('./logger');

// One shared client for normal commands. Sessions live only in Redis, so the
// office must refuse access while it is unreachable rather than wait: with the
// offline queue disabled, commands fail at once instead of queueing until reconnect.
const client = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
  },
});

// node-redis emits 'error' on every failed reconnect attempt; log state changes
// only. Only the message is logged: a connection error can carry the URL.
let reported = 'unknown';
client.on('ready', () => {
  reported = 'ready';
  logger.info('Redis ready');
});
client.on('error', (err) => {
  if (reported === 'down') return;
  reported = 'down';
  logger.error({ redisError: err.message || err.code }, 'Redis unavailable');
});

// Starts connecting in the background. The API serves the public shop without
// Redis; office routes answer 503 until the client is ready.
function connect() {
  if (!client.isOpen) {
    client.connect().catch(() => {}); // reported by the 'error' listener
  }
}

async function disconnect() {
  if (client.isReady) {
    await client.close();
  } else if (client.isOpen) {
    client.destroy();
  }
}

module.exports = { client, connect, disconnect };
