/* Request handling, shared by the long-running server (server/index.js) and
   the Vercel function (api/index.js). Requiring this module never listens on
   a port and never starts timers.
*/
const fs = require('fs');
const path = require('path');

const cfg = require('./lib/config');
const log = require('./lib/log');
const helpers = require('./lib/http');
const store = require('./lib/store');
const events = require('./lib/events');
const Router = require('./lib/router');
const tokens = require('./lib/token');
const jobs = require('./jobs/worker');

/* ------------------------------------------------------------ realtime SSE */

const clients = new Set();
/* `toEmails`, when given, limits delivery to those signed-in users. */
function broadcast(event, payload, exceptToken, toEmails) {
  const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  clients.forEach((c) => {
    if (c.token !== exceptToken && (!toEmails || toEmails.indexOf(c.email) >= 0)) { try { c.res.write(frame); } catch (e) { clients.delete(c); } }
  });
}

/* ---------------------------------------------------------------- identity */

function sessionOf(req) {
  const raw = req.headers.authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const s = store.db.sessions[token];
  if (!s) return cfg.STATELESS_SESSIONS ? signedSession(token) : null;
  if (s.revoked) return null;
  /* tolerate the pre-refactor session shape */
  const email = typeof s === 'string' ? s : s.email;
  if (typeof s === 'object' && s.expires && s.expires < Date.now()) {
    delete store.db.sessions[token]; store.save(); return null;
  }
  return { token: token, email: email, user: store.db.users[email] || { email: email } };
}

/* A signed token issued by another instance. The local store may not know the
   user yet, so the account and its ID badge are restored from the claims. */
function signedSession(token) {
  const claims = tokens.verify(token);
  if (!claims) return null;
  const email = claims.e;
  let changed = false;
  let user = store.db.users[email];
  if (!user) {
    user = store.db.users[email] = { email: email, name: claims.n, joined: Date.now(), email_verified: true };
    changed = true;
  }
  if (claims.id && claims.id.verified && !(user.identity && user.identity.verified) && user.name === claims.n) {
    user.identity = claims.id;
    changed = true;
  }
  if (changed) store.save();
  return { token: token, email: email, user: user };
}

/* ------------------------------------------------------------------ router */

const router = new Router();
[
  './modules/auth', './modules/listings', './modules/housing', './modules/roommates',
  './modules/favorites', './modules/messaging', './modules/events',
  './modules/recommendations', './modules/moderation', './modules/analytics',
  './modules/ml', './modules/state', './modules/identity'
].forEach((m) => router.use(require(m)));

router.add('GET', '/api/stream', (ctx) => {
  /* serverless functions cannot hold a stream open; the client polls instead */
  if (cfg.IS_VERCEL) return helpers.json(ctx.res, 503, { error: 'Realtime stream unavailable here; poll /api/state.', code: 'STREAM_UNAVAILABLE' });
  ctx.res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'
  }, helpers.CORS));
  ctx.res.write('event: hello\ndata: {"ok":true}\n\n');
  const client = { res: ctx.res, token: ctx.token, email: ctx.user ? ctx.user.email : null };
  clients.add(client);
  const ping = setInterval(() => { try { ctx.res.write(': ping\n\n'); } catch (e) {} }, 25000);
  ctx.req.on('close', () => { clearInterval(ping); clients.delete(client); });
});

router.add('GET', '/api/admin/jobs', (ctx) => helpers.ok(ctx.res, { jobs: jobs.status() }), { admin: true });
router.add('GET', '/api/admin/metrics', (ctx) => helpers.ok(ctx.res, log.snapshot()), { admin: true });

/* --------------------------------------------------------- static serving */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(cfg.PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(cfg.PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': helpers.MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(buf);
  });
}

/* ----------------------------------------------------------------- handler */

function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') { res.writeHead(204, helpers.CORS); return res.end(); }

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);

  if (!helpers.rateLimit(helpers.clientIp(req) + '|' + url.pathname.split('/')[2])) return helpers.tooMany(res);

  const session = sessionOf(req);
  const email = session ? session.email : null;
  const ctx = {
    req: req, res: res, url: url, method: req.method, pathname: url.pathname.replace(/\/$/, '') || '/',
    token: session ? session.token : null,
    user: session ? session.user : null,
    analyticsId: events.pseudonymise(email),
    isAdmin: !!(email && cfg.ADMIN_EMAILS.indexOf(email) >= 0),
    broadcast: broadcast
  };

  router.handle(ctx).catch((e) => {
    log.error('router', ctx.method + ' ' + ctx.pathname, e);
    if (!res.headersSent) helpers.json(res, 500, { error: 'Internal error' });
  });
}

/* Serverless mode: one request at a time per instance, state re-read from the
   database first, background jobs run when due, and every write committed
   before the response is released (the instance may freeze right after). */
let queue = Promise.resolve();

function handleServerless(req, res) {
  const run = queue.then(() => new Promise((resolve) => {
    res.on('close', resolve);
    const end = res.end;
    res.end = function () {
      const args = arguments;
      res.end = end;
      store.commit().then(() => { end.apply(res, args); resolve(); });
      return res;
    };
    store.refresh()
      .then(() => { jobs.runDue(); handle(req, res); })
      .catch((e) => {
        log.error('server', 'request setup failed', e);
        if (!res.headersSent) helpers.json(res, 500, { error: 'Internal error' });
      });
  }));
  queue = run;
  return run;
}


/** Resolves once the initial state load has settled. */
const ready = store.ready;

module.exports = { handle, handleServerless, ready, router, broadcast, sessionOf };
