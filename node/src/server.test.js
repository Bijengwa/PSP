const knex = require('knex');
const request = require('supertest');
const knexfile = require('../knexfile');
const db = require('./db');
const { app, start, stop, errorHandler } = require('./server');

describe('GET /api/health', () => {
  test('reports ok when PostgreSQL is reachable', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ api: 'ok', database: 'ok' });
  });

  test('reports 503 and database "down" when PostgreSQL is unreachable', async () => {
    // A fresh copy of the app whose shared db points at a port nothing listens on.
    let unreachableDb;
    let downApp;
    jest.isolateModules(() => {
      jest.doMock('./db', () => {
        unreachableDb = knex({
          ...knexfile.test,
          connection: { ...knexfile.test.connection, port: 1 },
          acquireConnectionTimeout: 2000,
          // Knex prints connection failures itself; the test asserts on them instead.
          log: { warn() {}, error() {}, debug() {}, deprecate() {} },
        });
        return unreachableDb;
      });
      downApp = require('./server').app;
    });

    try {
      const res = await request(downApp).get('/api/health');

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toMatchObject({ api: 'ok', database: 'down' });
    } finally {
      await unreachableDb.destroy();
    }
  });
});

describe('proxy, headers and error responses', () => {
  test('trust proxy is off when TRUST_PROXY is unset, so X-Forwarded-For cannot spoof req.ip', () => {
    expect(app.get('trust proxy')).toBe(false);
  });

  test('TRUST_PROXY=1 means one hop; any other non-numeric value stops startup', () => {
    const saved = process.env.TRUST_PROXY;
    try {
      process.env.TRUST_PROXY = '1';
      jest.isolateModules(() => {
        expect(require('./server').app.get('trust proxy')).toBe(1);
      });
      process.env.TRUST_PROXY = 'true';
      jest.isolateModules(() => {
        expect(() => require('./server')).toThrow(/TRUST_PROXY/);
      });
    } finally {
      if (saved === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = saved;
    }
  });

  test('helmet headers are present and the stack is not advertised', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  test('CORS allows only the configured origin, with credentials', async () => {
    const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const foreign = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');
    expect(foreign.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    expect(foreign.headers['access-control-allow-origin']).not.toBe('*');
  });

  test('unknown API routes do not echo the request path', async () => {
    const res = await request(app).get('/api/nope-marker');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/nope-marker/);
  });

  test('malformed JSON gets a fixed 400 message with no parser details', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .set('Content-Type', 'application/json')
      .send('{"email": oops');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: { message: 'Invalid request body' } });
  });

  test('an oversized body gets a fixed 413', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email: 'x'.repeat(1024 * 1024 + 10) });
    expect(res.status).toBe(413);
    expect(res.body.error.message).toBe('Request body too large');
  });

  test('a 5xx error never leaks its message', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    errorHandler(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), { log: { error() {} } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
  });
});

// Runs last: stop() destroys this file's shared pool.
describe('startup and graceful shutdown', () => {
  test('start() rejects when the port is already in use', async () => {
    const first = await start(0);
    try {
      await expect(start(first.address().port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise((resolve) => first.close(resolve));
    }
  });

  test('boots, serves requests, then closes the server and the shared pool', async () => {
    const server = await start(0);
    expect(server.listening).toBe(true);

    const res = await request(server).get('/api/health');
    expect(res.status).toBe(200);
    expect(db.client.pool).toBeDefined();

    await stop(server);

    expect(server.listening).toBe(false);
    expect(db.client.pool).toBeUndefined();
  });
});
