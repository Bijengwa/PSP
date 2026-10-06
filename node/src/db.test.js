const knex = require('knex');
const knexfile = require('../knexfile');
const db = require('./db');

afterAll(() => db.destroy());

// Loads knexfile.js (and optionally db.js) in a fresh module registry with the
// given env overrides, then restores the original env.
function loadWithEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    let result;
    jest.isolateModules(() => {
      result = fn();
    });
    return result;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('environment selection', () => {
  test('the shared instance uses the test configuration and test database', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    // Compare single fields: a full-config diff would print the DB password on failure.
    expect(db.client.config.connection.database).toBe(knexfile.test.connection.database);

    const { rows } = await db.raw('select current_database() as name');
    expect(rows[0].name).toBe(knexfile.test.connection.database);
  });

  test('defines development, test and production', () => {
    expect(Object.keys(knexfile).sort()).toEqual(['development', 'production', 'test']);
  });
});

describe('connection pool', () => {
  test('the shared pool is created with the configured limits', async () => {
    await db.raw('select 1');
    const pool = db.client.pool;

    expect(pool.min).toBe(0);
    expect(pool.max).toBe(knexfile.test.pool.max);
    expect(pool.idleTimeoutMillis).toBe(knexfile.test.pool.idleTimeoutMillis);
    expect(pool.acquireTimeoutMillis).toBe(knexfile.test.acquireConnectionTimeout);
  });

  test('queries reuse connections from the shared pool', async () => {
    await db.raw('select 1');
    await db.raw('select 1');
    const pool = db.client.pool;

    expect(pool.numUsed()).toBe(0);
    expect(pool.numFree()).toBe(1);
  });

  test('DB_POOL_MAX defaults to 10 and is read from the environment', () => {
    const defaults = loadWithEnv({ DB_POOL_MAX: '' }, () => require('../knexfile'));
    expect(defaults.test.pool.max).toBe(10);

    const custom = loadWithEnv({ DB_POOL_MAX: '4' }, () => require('../knexfile'));
    expect(custom.test.pool.max).toBe(4);
    expect(custom.production.pool.max).toBe(4);
  });

  test('a malformed numeric setting fails at load time', () => {
    expect(() => loadWithEnv({ DB_POOL_MAX: 'ten' }, () => require('../knexfile'))).toThrow(
      /DB_POOL_MAX must be a non-negative integer/,
    );
  });
});

describe('statement timeout', () => {
  test('is applied to connections from the shared pool', async () => {
    const { rows } = await db.raw(
      "select extract(epoch from current_setting('statement_timeout')::interval) * 1000 as ms",
    );
    expect(Number(rows[0].ms)).toBe(knexfile.test.connection.statement_timeout);
  });

  test('is read from DB_STATEMENT_TIMEOUT_MS', () => {
    const config = loadWithEnv({ DB_STATEMENT_TIMEOUT_MS: '1234' }, () => require('../knexfile'));
    expect(config.test.connection.statement_timeout).toBe(1234);
  });

  test('Postgres cancels a statement that runs past the timeout', async () => {
    const config = loadWithEnv({ DB_STATEMENT_TIMEOUT_MS: '100' }, () => require('../knexfile'));
    const shortTimeoutDb = knex(config.test);
    try {
      await expect(shortTimeoutDb.raw('select pg_sleep(2)')).rejects.toMatchObject({
        code: '57014', // query_canceled
      });
    } finally {
      await shortTimeoutDb.destroy();
    }
  });
});

describe('production configuration', () => {
  test('db.js loads under NODE_ENV=production without throwing', async () => {
    const prodDb = loadWithEnv({ NODE_ENV: 'production', DB_SSL: 'false' }, () => require('./db'));
    try {
      expect(prodDb.client.config.connection.database).toBe(process.env.DB_NAME);
      expect(prodDb.client.config.pool.min).toBe(0);
    } finally {
      await prodDb.destroy();
    }
  });

  test('SSL is off unless DB_SSL=true', () => {
    const config = loadWithEnv({ DB_SSL: 'false' }, () => require('../knexfile'));
    expect(config.production.connection.ssl).toBe(false);
  });

  test('DB_SSL=true enables SSL with certificate verification by default', () => {
    const config = loadWithEnv(
      { DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: '', DB_SSL_CA_FILE: '' },
      () => require('../knexfile'),
    );
    expect(config.production.connection.ssl).toEqual({ rejectUnauthorized: true });
  });

  test('certificate verification can be turned off explicitly', () => {
    const config = loadWithEnv(
      { DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false', DB_SSL_CA_FILE: '' },
      () => require('../knexfile'),
    );
    expect(config.production.connection.ssl).toEqual({ rejectUnauthorized: false });
  });

  test('SSL settings never apply to development or test', () => {
    const config = loadWithEnv({ DB_SSL: 'true', DB_SSL_CA_FILE: '' }, () => require('../knexfile'));
    expect(config.development.connection.ssl).toBe(false);
    expect(config.test.connection.ssl).toBe(false);
  });
});
