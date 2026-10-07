require('dotenv').config({ quiet: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./db');
const redis = require('./redis');
const { logger, createHttpLogger } = require('./logger');

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// ---------- Global middleware ----------
// First, so every response (including errors) carries X-Request-Id and gets logged.
app.use(createHttpLogger(logger));
app.use(helmet());
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// ---------- Routes ----------
app.get('/api/health', async (req, res) => {
  let database = 'ok';
  try {
    await db.raw('select 1');
  } catch (err) {
    database = 'down';
  }

  // Redis only holds office sessions; the public shop works without it, so it is
  // reported but does not make the API unhealthy.
  let redisStatus = 'ok';
  try {
    await redis.client.ping();
  } catch (err) {
    redisStatus = 'down';
  }

  const healthy = database === 'ok';
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: {
      api: 'ok',
      database,
      redis: redisStatus,
      time: new Date().toISOString(),
    },
  });
});

// Feature routers
app.use('/api/auth', require('./auth/auth.routes'));
app.use('/api/office', require('./auth/auth.routes').officeRouter);

// ---------- 404 for unknown API routes ----------
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: { message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
});

// ---------- Central error handler ----------
// Express 5 forwards errors thrown in async handlers here automatically.
// Throw an error with a `status` (or `statusCode`) property to control the response code.
// The full error (stack included) goes to the log with the request ID; the client
// only ever sees the generic message for 5xx, unless the error sets `expose: true`
// because its message is known to be safe.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    (req.log || logger).error({ err, reqId: req.id }, 'Unhandled error');
  }

  res.status(status).json({
    success: false,
    error: {
      message: status >= 500 && !err.expose ? 'Internal server error' : err.message,
      ...(status < 500 && err.code && { code: err.code }),
      ...(err.details && { details: err.details }),
    },
  });
}

app.use(errorHandler);

// ---------- Start / stop ----------
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    // Express 5 also calls this callback when listening fails (e.g. port in use).
    const server = app.listen(port, (err) => {
      if (err) return reject(err);
      logger.info({ port: server.address().port }, 'PSP API listening');
      redis.connect();
      resolve(server);
    });
  });
}

// Stops accepting connections, waits for in-flight requests to finish,
// then closes the Redis client and the shared database pool.
async function stop(server) {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('HTTP server closed');
  }
  await redis.disconnect();
  await db.destroy();
  logger.info('Database pool closed');
}

// Only listen when run directly (npm start / npm run dev), not when imported by tests.
if (require.main === module) {
  start()
    .then((server) => {
      let shuttingDown = false;
      function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ signal }, 'Shutting down');

        // A client holding a keep-alive socket open must not block shutdown forever.
        setTimeout(() => server.closeAllConnections(), 10000).unref();

        stop(server).then(
          () => process.exit(0),
          (err) => {
            logger.error({ err }, 'Shutdown failed');
            process.exit(1);
          },
        );
      }

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch(async (err) => {
      logger.error({ err }, 'Startup failed');
      await redis.disconnect();
      await db.destroy();
      process.exit(1);
    });
}

module.exports = { app, start, stop, errorHandler };
