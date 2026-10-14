/* Persistence.

   Two very different stores, deliberately separated:

   1. application state (users, listings, threads...) — MUTABLE.
      Backed by db.json, or by MongoDB when TM_MONGO_URI is set.
   2. events.jsonl — APPEND-ONLY raw behavioural events. Never rewritten,
                     never back-filled when ranking logic changes. Derived
                     datasets are regenerated from this file instead.
                     ALWAYS on disk — the Mongo migration does not touch it.

   The `db` object is the contract. Modules mutate it synchronously and call
   save(); which backend persists it is invisible to them. `db` is exported by
   reference and is NEVER reassigned — the Mongo loader rewrites its contents
   in place, because every module captured this exact object at require time.
*/
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const log = require('./log');
const mongo = require('./mongo');
const { SEED } = require('../data');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

function emptyDb() {
  return {
    schema_version: 3,
    users: {},
    sessions: {},
    codes: {},
    listings: SEED.map((l) => Object.assign({}, l)),   // copy: never alias the seed constant
    favorites: {},
    threads: [],
    offers: [],
    transactions: [],
    reports: [],
    moderation_decisions: [],
    housing_profiles: {},
    roommate_profiles: {},
    roommate_outcomes: [],
    housing_preference_pairs: [],
    behavior: {},
    profiles: {},
    recommendation_impressions: [],
    model_versions: [],
    experiments: [],
    experiment_assignments: {},
    notifications: [],
    blocked: {}
  };
}

function migrate(db) {
  const base = emptyDb();
  Object.keys(base).forEach((k) => { if (db[k] === undefined) db[k] = base[k]; });
  if (!db.listings || !db.listings.length) db.listings = SEED.map((l) => Object.assign({}, l));
  db.schema_version = base.schema_version;
  return db;
}

/* ---------------------------------------------------------------- backends

   'file'   — db.json. The default, and byte-for-byte the pre-migration path.
   'mongo'  — TM_MONGO_URI is set and reachable.
   'memory' — TM_MONGO_URI is set but unreachable. Seeded defaults, no
              persistence. The marketplace still serves rather than crashing.
*/
let backend = cfg.MONGO_URI ? 'mongo' : 'file';

let db;

if (backend === 'file') {
  /* unchanged from the file-only implementation: synchronous read at require
     time, so nothing downstream has to await anything */
  try {
    db = migrate(JSON.parse(fs.readFileSync(cfg.DB_FILE, 'utf8')));
    log.info('store', 'loaded db.json', { listings: db.listings.length, users: Object.keys(db.users).length });
  } catch (e) {
    db = emptyDb();
    log.info('store', 'fresh database seeded', { listings: db.listings.length });
  }
} else {
  /* Mongo mode: start from the seeded shape so `db` is never undefined, then
     fill it in place once the connection resolves. index.js will not accept
     requests until `ready` settles, so no request can observe this state. */
  db = emptyDb();
}

/** Resolves when the initial load is complete. Awaited before listen(). */
const ready = backend === 'file' ? Promise.resolve({ backend: 'file' }) : initMongo();

async function initMongo() {
  const t = log.timer('db.connect');
  const conn = await mongo.connect();
  t();

  if (!conn.ok) {
    backend = 'memory';
    log.error('store', 'MongoDB unreachable at ' + cfg.MONGO_URI + ' — ' + conn.reason);
    log.warn('store', 'falling back to IN-MEMORY state: the app will serve normally but NOTHING WILL PERSIST');
    return { backend: 'memory', error: conn.reason };
  }

  try {
    const result = await mongo.loadInto(db, emptyDb);
    if (result.empty) {
      /* first boot against an empty database — same fresh-install path as the
         file backend, persisted immediately so the seed is durable */
      mongo.hydrate(db, emptyDb());
      await mongo.syncAll(db);
      log.info('store', 'empty database seeded and persisted', {
        database: cfg.MONGO_DB, listings: db.listings.length
      });
    } else {
      migrate(db);
      log.info('store', 'loaded state from MongoDB', {
        database: cfg.MONGO_DB, listings: db.listings.length, users: Object.keys(db.users).length
      });
    }
    return { backend: 'mongo' };
  } catch (e) {
    backend = 'memory';
    log.error('store', 'MongoDB load failed — falling back to in-memory state', e);
    mongo.hydrate(db, emptyDb());
    return { backend: 'memory', error: e.message };
  }
}

/* debounced write so a burst of requests costs one round trip */
let queued = false;
let inFlight = null;

function flush() {
  if (backend === 'memory') return Promise.resolve();

  if (backend === 'file') {
    const t = log.timer('db.write');
    return new Promise((resolve) => {
      fs.writeFile(cfg.DB_FILE, JSON.stringify(db), (err) => {
        t();
        if (err) log.error('store', 'db write failed', err);
        resolve();
      });
    });
  }

  const t = log.timer('db.write');
  inFlight = mongo.syncAll(db)
    .catch((err) => log.error('store', 'mongo sync failed — state is still correct in memory', err))
    .then(() => { t(); inFlight = null; });
  return inFlight;
}

/** Unchanged signature and debounce: fire-and-forget, 150ms coalescing. */
function save() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    flush();
  }, 150);
}

/** Flush pending writes and release the connection. */
async function close() {
  await flush();
  if (inFlight) await inFlight;
  if (backend === 'mongo') await mongo.close();
}

/* ------------------------------------------------ append-only event store */

ensureDir(path.dirname(cfg.EVENT_LOG));
let eventStream = fs.createWriteStream(cfg.EVENT_LOG, { flags: 'a' });
eventStream.on('error', (e) => log.error('events', 'write stream failed', e));

let eventCount = 0;
try {
  eventCount = fs.readFileSync(cfg.EVENT_LOG, 'utf8').split('\n').filter(Boolean).length;
} catch (e) { eventCount = 0; }

/* Events are written to disk asynchronously, so a read immediately after a
   write would miss them. This tail buffer keeps the most recent rows in memory
   and readEvents() merges them, making the store read-your-writes consistent. */
const tail = [];
const TAIL_MAX = 5000;

/** Append events. Immutable: no update or delete path exists by design. */
function appendEvents(rows) {
  if (!rows.length) return 0;
  const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  eventStream.write(payload, (err) => { if (err) log.error('events', 'append failed', err); });
  rows.forEach((r) => { tail.push(r); });
  while (tail.length > TAIL_MAX) tail.shift();
  eventCount += rows.length;
  log.bump('events.appended', rows.length);
  return rows.length;
}

function eventTotal() { return eventCount; }

function matches(ev, o) {
  if (o.since && ev.timestamp < o.since) return false;
  if (o.until && ev.timestamp > o.until) return false;
  if (o.user_id && ev.user_id !== o.user_id) return false;
  if (o.event_type && ev.event_type !== o.event_type) return false;
  if (o.surface && ev.surface !== o.surface) return false;
  return true;
}

/** Read events from disk, then merge the not-yet-flushed tail. */
function readEvents(opts) {
  const o = opts || {};
  const out = [];
  const seen = new Set();
  let raw = '';
  try { raw = fs.readFileSync(cfg.EVENT_LOG, 'utf8'); } catch (e) { raw = ''; }
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let ev;
    try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
    if (ev.event_id) seen.add(ev.event_id);
    if (!matches(ev, o)) continue;
    out.push(ev);
    if (o.limit && out.length >= o.limit) return out;
  }
  for (let i = 0; i < tail.length; i++) {
    const ev = tail[i];
    if (ev.event_id && seen.has(ev.event_id)) continue;
    if (!matches(ev, o)) continue;
    out.push(ev);
    if (o.limit && out.length >= o.limit) break;
  }
  return out;
}

/* rolling in-memory aggregate so analytics never re-reads the whole log */
const agg = { by_type: {}, by_surface: {}, users: {}, sessions: {}, listings: {}, day: {} };

function aggregate(ev) {
  agg.by_type[ev.event_type] = (agg.by_type[ev.event_type] || 0) + 1;
  if (ev.surface) agg.by_surface[ev.surface] = (agg.by_surface[ev.surface] || 0) + 1;
  if (ev.user_id) agg.users[ev.user_id] = (agg.users[ev.user_id] || 0) + 1;
  if (ev.session_id) agg.sessions[ev.session_id] = (agg.sessions[ev.session_id] || 0) + 1;
  if (ev.listing_id) agg.listings[ev.listing_id] = (agg.listings[ev.listing_id] || 0) + 1;
  const day = new Date(ev.timestamp || Date.now()).toISOString().slice(0, 10);
  agg.day[day] = agg.day[day] || {};
  agg.day[day][ev.event_type] = (agg.day[day][ev.event_type] || 0) + 1;
}

/* warm the aggregate from disk once at boot */
readEvents({}).forEach(aggregate);

module.exports = {
  db, save, appendEvents, readEvents, eventTotal, aggregate, agg, emptyDb, tail,
  /* migration surface */
  ready, flush, close,
  backend: () => backend
};
