require('dotenv').config({ quiet: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./db');

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// ---------- Global middleware ----------
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

  const healthy = database === 'ok';
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: {
      api: 'ok',
      database,
      time: new Date().toISOString(),
    },
  });
});

// Feature routers are mounted here as they are built, e.g.:
// app.use('/api/auth', require('./modules/auth/auth.routes'));

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
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    console.error(err);
  }

  res.status(status).json({
    success: false,
    error: {
      message: status >= 500 ? 'Internal server error' : err.message,
      ...(err.details && { details: err.details }),
    },
  });
});

// ---------- Start / stop ----------
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.once('error', reject);
  });
}

// Stops accepting connections, waits for in-flight requests to finish,
// then closes the shared database pool.
async function stop(server) {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  await db.destroy();
}

// Only listen when run directly (npm start / npm run dev), not when imported by tests.
if (require.main === module) {
  start()
    .then((server) => {
      console.log(`PSP API listening on http://localhost:${PORT}`);

      let shuttingDown = false;
      function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`${signal} received, shutting down...`);

        // A client holding a keep-alive socket open must not block shutdown forever.
        setTimeout(() => server.closeAllConnections(), 10000).unref();

        stop(server).then(
          () => process.exit(0),
          (err) => {
            console.error(err);
            process.exit(1);
          },
        );
      }

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch(async (err) => {
      console.error(err);
      await db.destroy();
      process.exit(1);
    });
}

module.exports = { app, start, stop };
