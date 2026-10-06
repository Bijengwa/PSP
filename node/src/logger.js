const crypto = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');

// Credential fields are redacted wherever they appear, up to three levels deep
// (e.g. `password`, `body.password`, `req.body.password`), plus credential headers.
const SECRET_FIELDS = ['password', 'currentPassword', 'newPassword', 'token'];

const REDACT_PATHS = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => `*.${field}`),
  ...SECRET_FIELDS.map((field) => `*.*.${field}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

// development: readable pino-pretty output; production: JSON lines on stdout;
// test: silent unless LOG_LEVEL is set. A `destination` stream (used by tests)
// always receives plain JSON.
function buildOptions({ env = process.env.NODE_ENV || 'development', level = process.env.LOG_LEVEL } = {}) {
  const options = {
    level: level || (env === 'test' ? 'silent' : 'info'),
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  if (env === 'development') {
    options.transport = { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } };
  }
  return options;
}

function createLogger({ env, level, destination } = {}) {
  const options = buildOptions({ env, level });
  if (destination) {
    delete options.transport;
    return pino(options, destination);
  }
  return pino(options);
}

const logger = createLogger();

// Reuse a well-formed incoming X-Request-Id (e.g. from a proxy) so one ID follows
// the request end to end; anything else gets a fresh UUID.
const INCOMING_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function genReqId(req, res) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && INCOMING_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

function pathOf(url = '') {
  return url.split('?')[0];
}

// Request logging middleware. One line per request with method, path (query string
// dropped, since it may carry tokens), status and duration in ms (`responseTime`).
function createHttpLogger(baseLogger = logger) {
  return pinoHttp({
    logger: baseLogger,
    genReqId,
    // req.log only carries the request ID, so app logs stay small but traceable.
    quietReqLogger: true,
    autoLogging: { ignore: (req) => pathOf(req.url) === '/api/health' },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${pathOf(req.originalUrl || req.url)} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${pathOf(req.originalUrl || req.url)} ${res.statusCode}`,
    serializers: {
      req: (req) => ({
        method: req.method,
        path: pathOf(req.url),
        headers: req.headers,
        remoteAddress: req.remoteAddress,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}

module.exports = { logger, createLogger, createHttpLogger, buildOptions, REDACT_PATHS };
