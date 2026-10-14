/* MongoDB backend for the mutable application-state store.

   Scope: server/db.json only. The append-only event log (events.jsonl) is NOT
   touched — it stays on disk, because it is a different kind of data with
   different guarantees (see docs/ML_ARCHITECTURE.md).

   Document shape
   --------------
   The in-memory `db` has two kinds of top-level key, and they map differently
   so that the collections stay legible in mongosh:

     arrays  (listings, threads, offers, ...)
        -> one document per element, fields spread at the top level, so
           `db.listings.findOne()` returns a real listing. `_id` comes from the
           element's own id field when it has one; `_ord` preserves array order.

     maps    (users, sessions, favorites, ...)
        -> { _id: <key>, v: <value> }. Wrapped because the values are
           heterogeneous — favorites is an array, sessions is an object,
           behavior is an object — and a wrapper handles all of them uniformly.

   Both `_id` and `_ord` are stripped on load, so modules never see them and the
   in-memory shape is byte-identical to the file-backed version.
*/
const cfg = require('./config');
const log = require('./log');

/* Candidate primary keys, in priority order. Falls back to array index. */
const ID_FIELDS = [
  'id', 'event_id', 'offer_id', 'report_id', 'transaction_id', 'model_id',
  'experiment_id', 'outcome_id', 'decision_id', 'pair_id'
];

const META_COLLECTION = '_meta';

let client = null;
let database = null;

/** Lazy require: the driver is only needed in Mongo mode, so a file-mode
    checkout with no node_modules still boots. */
function loadDriver() {
  try { return require('mongodb'); }
  catch (e) { return null; }
}

function idOf(element, index) {
  if (element && typeof element === 'object') {
    for (let i = 0; i < ID_FIELDS.length; i++) {
      const v = element[ID_FIELDS[i]];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
  }
  return 'idx_' + index;
}

function classify(db) {
  const arrays = [];
  const maps = [];
  const scalars = [];
  Object.keys(db).forEach((k) => {
    const v = db[k];
    if (Array.isArray(v)) arrays.push(k);
    else if (v && typeof v === 'object') maps.push(k);
    else scalars.push(k);
  });
  return { arrays, maps, scalars };
}

/** Replace the CONTENTS of `target` in place. Never reassign — every module
    holds a reference to the same object via `store.db`. */
function hydrate(target, source) {
  Object.keys(target).forEach((k) => { delete target[k]; });
  Object.keys(source).forEach((k) => { target[k] = source[k]; });
  return target;
}

async function connect() {
  const driver = loadDriver();
  if (!driver) {
    return { ok: false, reason: "the 'mongodb' package is not installed — run: npm install" };
  }
  try {
    client = new driver.MongoClient(cfg.MONGO_URI, {
      serverSelectionTimeoutMS: cfg.MONGO_TIMEOUT_MS,
      connectTimeoutMS: cfg.MONGO_TIMEOUT_MS
    });
    await client.connect();
    database = client.db(cfg.MONGO_DB);
    await database.command({ ping: 1 });
    return { ok: true };
  } catch (e) {
    client = null;
    database = null;
    return { ok: false, reason: e.message };
  }
}

/**
 * Read every top-level key into `target`, in place.
 * @returns {{empty: boolean, counts: Object}}
 */
async function loadInto(target, emptyDb) {
  const base = emptyDb();
  const { arrays, maps } = classify(base);
  const next = {};
  const counts = {};
  let documents = 0;

  for (const key of arrays) {
    const docs = await database.collection(key).find({}).toArray();
    docs.sort((a, b) => (a._ord === undefined ? 0 : a._ord) - (b._ord === undefined ? 0 : b._ord));
    next[key] = docs.map((d) => {
      const row = Object.assign({}, d);
      delete row._id;
      delete row._ord;
      return row;
    });
    counts[key] = next[key].length;
    documents += next[key].length;
  }

  for (const key of maps) {
    const docs = await database.collection(key).find({}).toArray();
    const out = {};
    docs.forEach((d) => { out[d._id] = d.v; });
    next[key] = out;
    counts[key] = docs.length;
    documents += docs.length;
  }

  const meta = await database.collection(META_COLLECTION).findOne({ _id: 'schema' });
  next.schema_version = base.schema_version;

  /* same forward-migration the file path applies: any key added since the last
     write is filled from the current empty shape */
  Object.keys(base).forEach((k) => {
    if (next[k] === undefined) next[k] = base[k];
  });

  hydrate(target, next);
  return { empty: documents === 0 && !meta, counts: counts };
}

/**
 * Full-state sync. Mirrors the file version's "rewrite everything" semantics:
 * after this resolves, Mongo contains exactly what is in memory.
 *
 * Implemented as upsert-all + delete-absent rather than drop-and-reinsert, so a
 * failure mid-sync can never leave a collection empty. The end state is
 * identical; only the failure mode is better.
 */
async function syncAll(db) {
  const { arrays, maps } = classify(db);

  for (const key of arrays) {
    const coll = database.collection(key);
    const docs = db[key].map((element, i) => {
      const doc = Object.assign({}, element);
      doc._id = idOf(element, i);
      doc._ord = i;
      return doc;
    });
    if (docs.length) {
      await coll.bulkWrite(
        docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
        { ordered: false }
      );
      await coll.deleteMany({ _id: { $nin: docs.map((d) => d._id) } });
    } else {
      await coll.deleteMany({});
    }
  }

  for (const key of maps) {
    const coll = database.collection(key);
    const keys = Object.keys(db[key]);
    if (keys.length) {
      await coll.bulkWrite(
        keys.map((k) => ({
          replaceOne: { filter: { _id: k }, replacement: { _id: k, v: db[key][k] }, upsert: true }
        })),
        { ordered: false }
      );
      await coll.deleteMany({ _id: { $nin: keys } });
    } else {
      await coll.deleteMany({});
    }
  }

  await database.collection(META_COLLECTION).replaceOne(
    { _id: 'schema' },
    { _id: 'schema', schema_version: db.schema_version, updated_at: new Date() },
    { upsert: true }
  );
}

async function close() {
  if (client) {
    try { await client.close(); } catch (e) { log.error('mongo', 'close failed', e); }
  }
  client = null;
  database = null;
}

function connected() { return !!database; }

module.exports = { connect, loadInto, syncAll, close, connected, hydrate, classify, idOf, loadDriver };
