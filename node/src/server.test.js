const knex = require('knex');
const request = require('supertest');
const knexfile = require('../knexfile');
const db = require('./db');
const { app, start, stop } = require('./server');

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

// Runs last: stop() destroys this file's shared pool.
describe('startup and graceful shutdown', () => {
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
