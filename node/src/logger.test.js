const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { logger, createLogger, createHttpLogger, buildOptions } = require('./logger');
const { errorHandler } = require('./server');
const sharedDb = require('./db');

afterAll(() => sharedDb.destroy());

// Distinctive values, so a leak anywhere in the raw output is caught.
const SECRETS = {
  password: 'Pw-S3cret-11111',
  currentPassword: 'Pw-S3cret-22222',
  newPassword: 'Pw-S3cret-33333',
  token: 'tok-S3cret-44444',
  bearer: 'Bearer bearer-S3cret-55555',
  cookie: 'psp_sid=cookie-S3cret-66666',
};

// Collects every line the logger writes, exactly as it would reach stdout.
function capture() {
  const raw = [];
  return {
    stream: { write: (line) => raw.push(line) },
    text: () => raw.join(''),
    lines: () => raw.map((line) => JSON.parse(line)),
  };
}

function expectNoSecrets(text) {
  for (const value of Object.values(SECRETS)) {
    expect(text).not.toContain(value.replace(/^Bearer /, ''));
  }
}

// pino-http writes the request line when the response closes, which can land
// a tick after supertest resolves.
async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for log line');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A fresh copy of the real server whose shared logger writes into `cap`.
function loadServerWithCapture(level = 'info') {
  const cap = capture();
  let server;
  let db;
  jest.isolateModules(() => {
    jest.doMock('./logger', () => {
      const actual = jest.requireActual('./logger');
      return { ...actual, logger: actual.createLogger({ env: 'test', level, destination: cap.stream }) };
    });
    server = require('./server');
    db = require('./db');
  });
  // doMock outlives isolateModules; later requires must get the real module.
  jest.dontMock('./logger');
  return { ...server, db, cap };
}

describe('request logging (real server)', () => {
  let srv;
  beforeAll(() => {
    srv = loadServerWithCapture();
  });
  afterAll(() => srv.db.destroy());

  const requestLines = () => srv.cap.lines().filter((line) => line.req && line.res);

  test('every response carries an X-Request-Id that matches the log line', async () => {
    const res = await request(srv.app).get('/api/no-such-route');

    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => requestLines().some((line) => line.reqId === id));
  });

  test('a well-formed incoming X-Request-Id is reused; a malformed one is replaced', async () => {
    const reused = await request(srv.app).get('/api/no-such-route').set('X-Request-Id', 'proxy-abc.123');
    expect(reused.headers['x-request-id']).toBe('proxy-abc.123');

    const replaced = await request(srv.app).get('/api/no-such-route').set('X-Request-Id', 'bad id forged');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the request log has method, path, status and duration', async () => {
    const res = await request(srv.app).get(`/api/no-such-route?token=${SECRETS.token}`);
    const id = res.headers['x-request-id'];
    await waitFor(() => requestLines().some((line) => line.reqId === id));

    const line = requestLines().find((l) => l.reqId === id);
    expect(line.req.method).toBe('GET');
    expect(line.req.path).toBe('/api/no-such-route');
    expect(line.res.statusCode).toBe(404);
    expect(typeof line.responseTime).toBe('number');
    expect(line.msg).toBe('GET /api/no-such-route 404');
    // The query string (which can carry tokens) is not logged at all.
    expect(srv.cap.text()).not.toContain(SECRETS.token);
  });

  test('/api/health produces no request log line', async () => {
    const health = await request(srv.app).get('/api/health');
    expect(health.headers['x-request-id']).toBeDefined();

    // A later request's line proves logging has caught up before checking.
    const after = await request(srv.app).get('/api/no-such-route');
    await waitFor(() => requestLines().some((line) => line.reqId === after.headers['x-request-id']));

    expect(requestLines().some((line) => line.req.path === '/api/health')).toBe(false);
    expect(srv.cap.text()).not.toContain(health.headers['x-request-id']);
  });

  test('authorization and cookie headers are redacted', async () => {
    const res = await request(srv.app)
      .get('/api/no-such-route')
      .set('Authorization', SECRETS.bearer)
      .set('Cookie', SECRETS.cookie);
    const id = res.headers['x-request-id'];
    await waitFor(() => requestLines().some((line) => line.reqId === id));

    const line = requestLines().find((l) => l.reqId === id);
    expect(line.req.headers.authorization).toBe('[REDACTED]');
    expect(line.req.headers.cookie).toBe('[REDACTED]');
    expectNoSecrets(srv.cap.text());
  });
});

describe('redaction of credential fields', () => {
  test('password, currentPassword, newPassword and token are redacted at any common depth', () => {
    const cap = capture();
    const log = createLogger({ env: 'test', level: 'info', destination: cap.stream });
    const fields = {
      password: SECRETS.password,
      currentPassword: SECRETS.currentPassword,
      newPassword: SECRETS.newPassword,
      token: SECRETS.token,
    };

    log.info(fields, 'top level');
    log.info({ body: fields }, 'one level');
    log.info({ req: { body: fields } }, 'two levels');

    const [top, one, two] = cap.lines();
    for (const key of Object.keys(fields)) {
      expect(top[key]).toBe('[REDACTED]');
      expect(one.body[key]).toBe('[REDACTED]');
      expect(two.req.body[key]).toBe('[REDACTED]');
    }
    expectNoSecrets(cap.text());
  });

  test('a body logged through req.log inside a request is redacted', async () => {
    const cap = capture();
    const log = createLogger({ env: 'test', level: 'info', destination: cap.stream });
    const app = express();
    app.use(createHttpLogger(log));
    app.use(express.json());
    app.post('/echo', (req, res) => {
      req.log.info({ body: req.body }, 'received body');
      res.status(204).end();
    });

    await request(app)
      .post('/echo')
      .set('Authorization', SECRETS.bearer)
      .set('Cookie', SECRETS.cookie)
      .send({
        email: 'staff@example.com',
        password: SECRETS.password,
        currentPassword: SECRETS.currentPassword,
        newPassword: SECRETS.newPassword,
        token: SECRETS.token,
      });
    await waitFor(() => cap.lines().some((line) => line.res));

    const bodyLine = cap.lines().find((line) => line.msg === 'received body');
    expect(bodyLine.body.email).toBe('staff@example.com');
    expect(bodyLine.body.password).toBe('[REDACTED]');
    expect(bodyLine.body.token).toBe('[REDACTED]');
    expectNoSecrets(cap.text());
  });

  test('Set-Cookie response headers are redacted if they are ever logged', () => {
    const cap = capture();
    const log = createLogger({ env: 'test', level: 'info', destination: cap.stream });

    log.info({ res: { headers: { 'set-cookie': SECRETS.cookie } } }, 'response');

    expect(cap.lines()[0].res.headers['set-cookie']).toBe('[REDACTED]');
    expectNoSecrets(cap.text());
  });
});

describe('central error handler', () => {
  function appThatThrows(err) {
    const cap = capture();
    const log = createLogger({ env: 'test', level: 'info', destination: cap.stream });
    const app = express();
    app.use(createHttpLogger(log));
    app.get('/boom', () => {
      throw err;
    });
    app.use(errorHandler);
    return { app, cap };
  }

  test('logs the error with the request ID and returns only a generic message', async () => {
    const { app, cap } = appThatThrows(new Error('relation "internal_table" does not exist'));

    const res = await request(app).get('/boom');
    const id = res.headers['x-request-id'];

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: { message: 'Internal server error' } });
    expect(res.text).not.toContain('internal_table');
    expect(res.text).not.toContain('stack');

    const errorLine = cap.lines().find((line) => line.msg === 'Unhandled error');
    expect(errorLine.level).toBe(50); // pino "error"
    expect(errorLine.reqId).toBe(id);
    expect(errorLine.err.message).toBe('relation "internal_table" does not exist');
    expect(errorLine.err.stack).toContain('internal_table');
  });

  test('client errors (4xx) keep their message and are not logged as unhandled', async () => {
    const err = Object.assign(new Error('Email is required'), { status: 400 });
    const { app, cap } = appThatThrows(err);

    const res = await request(app).get('/boom');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: { message: 'Email is required' } });
    expect(cap.lines().some((line) => line.msg === 'Unhandled error')).toBe(false);
  });
});

describe('startup and shutdown', () => {
  test('start() and stop() report through the shared logger', async () => {
    const srv = loadServerWithCapture();

    const server = await srv.start(0);
    const { port } = server.address();
    await srv.stop(server);

    // Redis connection state lines depend on whether Redis runs locally.
    const lines = srv.cap.lines().filter((line) => !line.msg.startsWith('Redis'));
    expect(lines.map((line) => line.msg)).toEqual(['PSP API listening', 'HTTP server closed', 'Database pool closed']);
    expect(lines[0].port).toBe(port);
  });

  test('server.js no longer writes to the console directly', () => {
    const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });
});

describe('configuration', () => {
  test('LOG_LEVEL is respected', () => {
    const cap = capture();
    const log = createLogger({ env: 'production', level: 'warn', destination: cap.stream });

    log.info('dropped');
    log.warn('kept');

    expect(cap.lines().map((line) => line.msg)).toEqual(['kept']);
  });

  test('LOG_LEVEL is read from the environment', () => {
    const saved = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
      expect(buildOptions({ env: 'production' }).level).toBe('debug');
      expect(buildOptions({ env: 'test' }).level).toBe('debug');
    } finally {
      if (saved === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = saved;
    }
  });

  test('tests are silent by default', () => {
    expect(buildOptions({ env: 'test', level: '' }).level).toBe('silent');
    if (process.env.LOG_LEVEL === undefined) {
      expect(logger.level).toBe('silent');
    }
  });

  test('production writes plain JSON lines; development uses pino-pretty', () => {
    expect(buildOptions({ env: 'production', level: '' })).not.toHaveProperty('transport');
    expect(buildOptions({ env: 'production', level: '' }).level).toBe('info');
    expect(buildOptions({ env: 'development', level: '' }).transport.target).toBe('pino-pretty');

    const cap = capture();
    createLogger({ env: 'production', level: 'info', destination: cap.stream }).info({ port: 5000 }, 'hello');
    expect(cap.lines()[0]).toMatchObject({ level: 30, msg: 'hello', port: 5000 });
  });
});
