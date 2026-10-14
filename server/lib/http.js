/* HTTP helpers: JSON, body parsing, validation, rate limiting, auth context. */
const cfg = require('./config');
const log = require('./log');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.md': 'text/markdown', '.woff2': 'font/woff2'
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

function json(res, code, payload) {
  const s = JSON.stringify(payload);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }, CORS));
  res.end(s);
}

const ok = (res, p) => json(res, 200, p);
const created = (res, p) => json(res, 201, p);
const badRequest = (res, msg, details) => json(res, 400, { error: msg, details: details || null });
const unauthorized = (res) => json(res, 401, { error: 'Sign in with a ' + cfg.AUTH_EMAIL_DOMAIN + ' email address first.' });
const forbidden = (res, msg) => json(res, 403, { error: msg || 'Not allowed.' });
const notFound = (res, msg) => json(res, 404, { error: msg || 'Not found.' });
const tooMany = (res) => json(res, 429, { error: 'Too many requests — slow down.' });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let aborted = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > (limit || 8e6)) { aborted = true; req.destroy(); reject(new Error('Payload too large')); }
    });
    req.on('end', () => {
      if (aborted) return;
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Malformed JSON body')); }
    });
    req.on('error', reject);
  });
}

/* ---- tiny schema validator: { field: {type, required, max, enum, min} } ---- */
function validate(obj, schema) {
  const errors = [];
  Object.keys(schema).forEach((k) => {
    const rule = schema[k];
    const v = obj[k];
    if (v === undefined || v === null || v === '') {
      if (rule.required) errors.push(k + ' is required');
      return;
    }
    if (rule.type === 'number' && typeof v !== 'number') { errors.push(k + ' must be a number'); return; }
    if (rule.type === 'string' && typeof v !== 'string') { errors.push(k + ' must be a string'); return; }
    if (rule.type === 'boolean' && typeof v !== 'boolean') { errors.push(k + ' must be a boolean'); return; }
    if (rule.type === 'array' && !Array.isArray(v)) { errors.push(k + ' must be an array'); return; }
    if (rule.enum && rule.enum.indexOf(v) < 0) errors.push(k + ' must be one of: ' + rule.enum.join(', '));
    if (rule.max !== undefined && typeof v === 'string' && v.length > rule.max) errors.push(k + ' exceeds ' + rule.max + ' characters');
    if (rule.min !== undefined && typeof v === 'number' && v < rule.min) errors.push(k + ' must be >= ' + rule.min);
  });
  return errors.length ? errors : null;
}

/* ---- fixed-window rate limiter, keyed by ip+route class ---- */
const buckets = new Map();
function rateLimit(key) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > cfg.RATE_LIMIT_WINDOW_MS) { buckets.set(key, { start: now, n: 1 }); return true; }
  b.n++;
  if (b.n > cfg.RATE_LIMIT_MAX) { log.bump('ratelimit.blocked'); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  buckets.forEach((b, k) => { if (now - b.start > cfg.RATE_LIMIT_WINDOW_MS * 4) buckets.delete(k); });
}, 60000).unref();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local';
}

/* ---- cursor pagination over a sorted array ---- */
function paginate(rows, cursor, limit) {
  const size = Math.max(1, Math.min(100, Number(limit) || 24));
  const start = cursor ? Math.max(0, Number(Buffer.from(String(cursor), 'base64url').toString('utf8')) || 0) : 0;
  const page = rows.slice(start, start + size);
  const next = start + size < rows.length ? Buffer.from(String(start + size)).toString('base64url') : null;
  return { items: page, next_cursor: next, total: rows.length };
}

module.exports = {
  MIME, CORS, json, ok, created, badRequest, unauthorized, forbidden, notFound, tooMany,
  readBody, validate, rateLimit, clientIp, paginate
};
