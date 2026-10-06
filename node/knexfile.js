const fs = require('fs');

require('dotenv').config({ quiet: true });

// Reads a non-negative integer from the environment, falling back to a default.
// Throws on a malformed value so a typo fails at startup instead of silently.
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

// SSL is opt-in through DB_SSL=true. Certificates are verified unless
// DB_SSL_REJECT_UNAUTHORIZED=false; DB_SSL_CA_FILE adds a custom CA bundle.
function sslFromEnv() {
  if (process.env.DB_SSL !== 'true') return false;

  const ssl = {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
  if (process.env.DB_SSL_CA_FILE) {
    ssl.ca = fs.readFileSync(process.env.DB_SSL_CA_FILE, 'utf8');
  }
  return ssl;
}

function baseConfig({ database, ssl = false }) {
  return {
    client: process.env.DB_CLIENT || 'pg',
    connection: {
      host: process.env.DB_HOST,
      port: intFromEnv('DB_PORT', 5432),
      database,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl,
      // Sent as a startup parameter, so every pooled connection gets it
      // without an extra round trip.
      statement_timeout: intFromEnv('DB_STATEMENT_TIMEOUT_MS', 30000),
    },
    // How long a query waits for a free pool connection before failing.
    acquireConnectionTimeout: intFromEnv('DB_ACQUIRE_TIMEOUT_MS', 10000),
    pool: {
      min: 0,
      max: intFromEnv('DB_POOL_MAX', 10),
      idleTimeoutMillis: intFromEnv('DB_IDLE_TIMEOUT_MS', 30000),
    },
    migrations: {
      directory: './migrations',
    },
    seeds: {
      directory: './seeds',
    },
  };
}

module.exports = {
  development: baseConfig({ database: process.env.DB_NAME }),

  test: baseConfig({ database: process.env.DB_TEST_NAME || 'psp_test' }),

  production: baseConfig({ database: process.env.DB_NAME, ssl: sslFromEnv() }),
};
