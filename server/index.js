/* Trojan Market — application entry point.

   Modular monolith: every domain lives in server/modules/* and registers its
   own routes. Nothing here knows how recommendations are produced, and the
   recommendation service knows nothing about HTTP.

   Node 18+. Zero runtime dependencies.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const cfg = require('./lib/config');
const log = require('./lib/log');
const helpers = require('./lib/http');
const store = require('./lib/store');
const events = require('./lib/events');
const Router = require('./lib/router');
const jobs = require('./jobs/worker');
const registry = require('./ml/registry');

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
  if (!s) return null;
  /* tolerate the pre-refactor session shape */
  const email = typeof s === 'string' ? s : s.email;
  if (typeof s === 'object' && s.expires && s.expires < Date.now()) {
    delete store.db.sessions[token]; store.save(); return null;
  }
  return { token: token, email: email, user: store.db.users[email] || { email: email } };
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

/* ------------------------------------------------------------------ server */

const server = http.createServer((req, res) => {
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
});

/* Boot only once the initial state load has resolved. In file mode this is
   already settled; in Mongo mode it waits for the connection and hydration, so
   no request can race an empty `db`. A failed connection resolves too (with the
   in-memory fallback) rather than rejecting — the marketplace still serves. */
store.ready.then((state) => {
  server.listen(cfg.PORT, () => {
    log.info('server', 'Trojan Market listening on http://localhost:' + cfg.PORT);
    log.info('server', 'state backend: ' + store.backend() +
      (state.backend === 'mongo' ? ' (' + cfg.MONGO_DB + ')' :
       state.backend === 'memory' ? ' — NOT PERSISTING, see the error above' : ' (server/db.json)'));
    log.info('server', store.db.listings.length + ' listings · ' + store.eventTotal() + ' events logged');
    log.info('server', 'recommendation mode: ' + registry.mode() +
      (registry.mode() === 'heuristic' ? ' (no ML model active — expected until real data accumulates)' : ''));
    if (!cfg.ADMIN_EMAILS.length) log.info('server', 'no TM_ADMINS set — admin endpoints are closed');
    jobs.start();
  });
});

/* flush pending state and release the connection on shutdown */
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    log.info('server', 'shutting down — flushing state');
    store.close().then(() => process.exit(0), () => process.exit(1));
  });
});

process.on('uncaughtException', (e) => log.error('process', 'uncaught exception', e));
process.on('unhandledRejection', (e) => log.error('process', 'unhandled rejection', e));

module.exports = { server, router, broadcast };
