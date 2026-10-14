/* Trojan Market — application entry point.

   Modular monolith: every domain lives in server/modules/* and registers its
   own routes. Nothing here knows how recommendations are produced, and the
   recommendation service knows nothing about HTTP.

   Node 18+. Zero runtime dependencies.
*/
const http = require('http');

const cfg = require('./lib/config');
const log = require('./lib/log');
const store = require('./lib/store');
const jobs = require('./jobs/worker');
const registry = require('./ml/registry');
const app = require('./app');

const server = http.createServer(app.handle);

/* Boot only once the initial state load has resolved. In file mode this is
   already settled; in Mongo mode it waits for the connection and hydration, so
   no request can race an empty `db`. A failed connection resolves too (with the
   in-memory fallback) rather than rejecting — the marketplace still serves. */
app.ready.then((state) => {
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

module.exports = { server, router: app.router, broadcast: app.broadcast, handle: app.handle, ready: app.ready };
