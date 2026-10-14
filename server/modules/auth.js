/* USC email-only authentication. */
const crypto = require('crypto');
const cfg = require('../lib/config');
const http = require('../lib/http');
const store = require('../lib/store');
const log = require('../lib/log');

const EMAIL_RE = new RegExp('^[^\\s@]+@' + cfg.AUTH_EMAIL_DOMAIN.replace('.', '\\.') + '$');

function nameFromEmail(email) {
  return email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* The fixed demo code exists only for local development. In production it is
   never used and never returned; a random code is issued for a mailer to send. */
function demoCode() {
  if (cfg.IS_PRODUCTION) return null;
  return cfg.DEMO_AUTH_CODE ? String(cfg.DEMO_AUTH_CODE) : null;
}

function issueCode() {
  return demoCode() || String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function sameCode(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function request(ctx) {
  const b = await http.readBody(ctx.req);
  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return http.badRequest(ctx.res, 'Use a valid @' + cfg.AUTH_EMAIL_DOMAIN + ' email address.');
  const code = issueCode();
  store.db.codes[email] = { code: code, expires: Date.now() + 15 * 60000 };
  store.save();
  /* In production this is where the mailer is called. Never log the code
     alongside anything else identifying. */
  log.info('auth', 'verification code issued');
  const body = { ok: true, expires_in_s: 900 };
  if (demoCode()) body.demoCode = demoCode();
  return http.ok(ctx.res, body);
}

async function verify(ctx) {
  const b = await http.readBody(ctx.req);
  const email = String(b.email || '').trim().toLowerCase();
  const rec = store.db.codes[email];
  if (!rec || rec.expires < Date.now()) return http.badRequest(ctx.res, 'Request a new code.');
  if (!sameCode(rec.code, String(b.code || '').trim())) return http.badRequest(ctx.res, 'That code is not right.');
  const token = crypto.randomBytes(24).toString('base64url');
  store.db.sessions[token] = { email: email, created: Date.now(), expires: Date.now() + cfg.SESSION_TTL_MS };
  store.db.users[email] = store.db.users[email] || { email: email, name: nameFromEmail(email), joined: Date.now(), email_verified: true };
  delete store.db.codes[email];
  store.save();
  return http.ok(ctx.res, { token: token, user: store.db.users[email] });
}

async function signout(ctx) {
  if (ctx.token) { delete store.db.sessions[ctx.token]; store.save(); }
  return http.ok(ctx.res, { ok: true });
}

async function me(ctx) {
  return http.ok(ctx.res, {
    user: ctx.user, analytics_id: ctx.analyticsId, is_admin: ctx.isAdmin
  });
}

async function config(ctx) {
  return http.ok(ctx.res, { email_domain: cfg.AUTH_EMAIL_DOMAIN, demo_code_enabled: !!demoCode() });
}

module.exports = {
  nameFromEmail, demoCode,
  routes: [
    { method: 'POST', path: '/api/auth/request', handler: request },
    { method: 'POST', path: '/api/auth/verify', handler: verify },
    { method: 'POST', path: '/api/auth/signout', handler: signout },
    { method: 'GET', path: '/api/auth/me', handler: me, opts: { auth: true } },
    { method: 'GET', path: '/api/auth/config', handler: config }
  ]
};
