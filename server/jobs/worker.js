/* Background worker. Keeps expensive work out of the request path.

   In production this becomes a separate process (or a queue consumer); the
   job functions below are written so that move requires no rewrite.
*/
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config');
const log = require('../lib/log');
const store = require('../lib/store');
const ranker = require('../recommendations/ranker');
const housing = require('../modules/housing');
const registry = require('../ml/registry');

const jobs = [];
function register(name, everyMs, fn) { jobs.push({ name: name, everyMs: everyMs, fn: fn, last: 0, runs: 0, failures: 0 }); }

/* ---- listing lifecycle: expire stale posts ---- */
register('expire_listings', 3600000, () => {
  const MAX_AGE_DAYS = 60;
  let n = 0;
  store.db.listings.forEach((l) => {
    const age = l.created_at ? (Date.now() - l.created_at) / 86400000 : (l.days || 0);
    if (age > MAX_AGE_DAYS && !l.sold && !l.expired) {
      l.expired = true; n++;
      require('../lib/events').emit('listing_expired', { listing_id: l.id }, {});
    }
  });
  if (n) store.save();
  return { expired: n };
});

/* ---- seller reliability recompute ---- */
register('refresh_seller_stats', 300000, () => {
  const s = ranker.refreshSellerStats();
  return { sellers: Object.keys(s).length };
});

/* ---- event aggregation snapshot for the dashboard ---- */
register('snapshot_aggregates', 600000, () => {
  const out = {
    at: Date.now(),
    events_total: store.eventTotal(),
    by_type: store.agg.by_type,
    unique_users: Object.keys(store.agg.users || {}).length,
    unique_sessions: Object.keys(store.agg.sessions || {}).length
  };
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.DATA_DIR, 'aggregates.json'), JSON.stringify(out, null, 2));
  } catch (e) { log.error('jobs', 'aggregate snapshot failed', e); }
  return out;
});

/* ---- pick up newly promoted model artifacts without a restart ---- */
register('reload_model_artifacts', 60000, () => {
  const before = registry.mode();
  housing.loadFittedWeights();
  const after = registry.mode();
  if (before !== after) log.info('jobs', 'recommendation mode changed', { from: before, to: after });
  return { mode: after };
});

/* ---- notification fan-out (async, never blocks a request) ---- */
const notifyQueue = [];
function enqueueNotification(n) { notifyQueue.push(Object.assign({ queued_at: Date.now() }, n)); }
register('deliver_notifications', 15000, () => {
  let sent = 0;
  while (notifyQueue.length) {
    const n = notifyQueue.shift();
    store.db.notifications.push(Object.assign({ delivered_at: Date.now() }, n));
    sent++;
    if (store.db.notifications.length > 2000) store.db.notifications.shift();
  }
  if (sent) store.save();
  return { delivered: sent };
});

/** Run every job whose interval has elapsed. The interval worker calls this on
    a timer; serverless deployments call it from the request path instead. */
function runDue(at) {
  const now = at || Date.now();
  jobs.forEach((j) => {
    if (now - j.last < j.everyMs) return;
    j.last = now;
    const done = log.timer('job.' + j.name);
    try { j.fn(); j.runs++; }
    catch (e) { j.failures++; log.error('jobs', j.name + ' failed', e); }
    finally { done(); }
  });
}

let timer = null;
function start() {
  timer = setInterval(runDue, cfg.JOB_INTERVAL_MS);
  timer.unref();
  log.info('jobs', 'worker started', { jobs: jobs.map((j) => j.name) });
}

function status() {
  return jobs.map((j) => ({ name: j.name, every_ms: j.everyMs, runs: j.runs, failures: j.failures, last_run: j.last || null }));
}

module.exports = { start, runDue, status, register, enqueueNotification, jobs };
