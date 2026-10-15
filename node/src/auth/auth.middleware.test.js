const express = require('express');
const request = require('supertest');

function loadMiddleware(env) {
  const saved = { NODE_ENV: process.env.NODE_ENV, CLIENT_ORIGIN: process.env.CLIENT_ORIGIN };
  Object.assign(process.env, env);
  let mod;
  jest.isolateModules(() => {
    mod = require('./auth.middleware');
  });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return mod;
}

function appWith(mod) {
  const app = express();
  app.get('/set', (req, res) => {
    mod.setSessionCookie(res, 'abc');
    res.json({});
  });
  app.get('/clear', (req, res) => {
    mod.clearSessionCookie(res);
    res.json({});
  });
  app.use(mod.requireSameOrigin);
  app.post('/change', (req, res) => res.json({ ok: true }));
  app.delete('/change', (req, res) => res.json({ ok: true }));
  app.get('/read', (req, res) => res.json({ ok: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));
  return app;
}

describe('session cookie flags', () => {
  test('production: HttpOnly, Secure, SameSite=Lax, path /', async () => {
    const res = await request(appWith(loadMiddleware({ NODE_ENV: 'production' }))).get('/set');
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^psp_sid=abc;/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Expires=/);
  });

  test('outside production the cookie is not Secure (plain-http dev), still HttpOnly', async () => {
    const res = await request(appWith(loadMiddleware({ NODE_ENV: 'development' }))).get('/set');
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).not.toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  test('clearing uses the same flags so the browser actually drops it', async () => {
    const res = await request(appWith(loadMiddleware({ NODE_ENV: 'production' }))).get('/clear');
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
  });
});

describe('requireSameOrigin', () => {
  const app = appWith(loadMiddleware({ CLIENT_ORIGIN: 'https://office.example.com' }));

  test.each(['post', 'delete'])('%s without an Origin header is 403', async (method) => {
    expect((await request(app)[method]('/change')).status).toBe(403);
  });

  test('a foreign Origin is 403', async () => {
    const res = await request(app).post('/change').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
  });

  test('look-alike origins are 403', async () => {
    for (const origin of ['https://office.example.com.evil.com', 'http://office.example.com', 'null']) {
      expect((await request(app).post('/change').set('Origin', origin)).status).toBe(403);
    }
  });

  test('the configured Origin is allowed', async () => {
    const res = await request(app).post('/change').set('Origin', 'https://office.example.com');
    expect(res.status).toBe(200);
  });

  test('GET is not checked', async () => {
    expect((await request(app).get('/read')).status).toBe(200);
  });
});
