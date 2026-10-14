#!/usr/bin/env node
/* Synthetic event fixture — FOR AUTOMATED PIPELINE TESTING ONLY.

   Writes to ml/fixtures/generated/, never to server/data/. Nothing here is
   production data and NO model performance number derived from it means
   anything. Its only job is to prove the pipeline mechanically executes:
   dataset build -> feature engineering -> LightGBM train -> evaluate ->
   artifact -> registry -> inference load.

   Usage:
     node ml/fixtures/generate_synthetic_events.js [--sessions 5000] [--seed 7]
     TM_EVENT_LOG=ml/fixtures/generated/events.jsonl \
       python ml/data/build_recommendation_dataset.py

   The generator embeds a deliberate, learnable signal (cheap + recent + photo
   listings get engaged with more often) so that a correctly wired ranker can
   demonstrably beat a random baseline. That is a WIRING check, not evidence.
*/
const fs = require('fs');
const path = require('path');
const { SEED, HOUSE } = require('../../server/data');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? Number(args[i + 1]) : d; };
const SESSIONS = argOf('sessions', 5000);
let seed = argOf('seed', 7);

/* deterministic PRNG so fixtures are reproducible */
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const pick = (a) => a[Math.floor(rnd() * a.length)];

const SURFACES = ['home', 'foryou', 'search', 'category', 'housing'];
const live = SEED.filter((l) => !l.sold);

/* Ground-truth utility the generator simulates. A ranker that works should be
   able to recover something like this from the logged behaviour. */
function appeal(listing, user) {
  let p = 0.04;
  if (user.favCategory === listing.category) p += 0.16;
  if ((listing.days || 0) <= 2) p += 0.06;
  if (listing.free || Number(listing.price) === 0) p += 0.05;
  if (listing.photo || listing.kw) p += 0.02;
  const h = HOUSE[listing.id];
  if (h && h.rent <= user.budget) p += 0.07;
  if (Number(listing.price) > user.budget * 2) p -= 0.03;
  return Math.max(0.005, Math.min(0.6, p));
}

const categories = Array.from(new Set(SEED.map((l) => l.category)));
const rows = [];
let t = Date.now() - 45 * 86400000;   // 45 days of history, strictly increasing

for (let s = 0; s < SESSIONS; s++) {
  /* derived from the session index so user coverage is guaranteed — sampling
     rnd() clumped and left the fixture under the 300-user gate */
  const userNum = (s * 97) % 480;
  const user = {
    id: 'u_synth_' + userNum,
    favCategory: categories[userNum % categories.length],
    budget: 700 + (userNum % 9) * 150
  };
  const sessionId = 's_synth_' + s;
  const surface = pick(SURFACES);
  const shown = 6 + Math.floor(rnd() * 14);

  t += 60000 + Math.floor(rnd() * 900000);
  const sessionStart = t;

  /* the pool this session saw, in served order */
  const pool = [];
  const used = new Set();
  while (pool.length < shown) {
    const l = pick(live);
    if (used.has(l.id)) continue;
    used.add(l.id); pool.push(l);
  }
  /* bias the served order toward appeal so position bias is REAL in the fixture
     and inverse-propensity handling has something to correct */
  pool.sort((a, b) => appeal(b, user) - appeal(a, user) + (rnd() - 0.5) * 0.25);

  pool.forEach((l, rank) => {
    rows.push({
      event_id: 'ev_synth_' + rows.length,
      schema_version: 1,
      user_id: user.id, session_id: sessionId, listing_id: l.id,
      event_type: 'impression', known_type: true,
      timestamp: sessionStart + rank * 120, received_at: sessionStart + rank * 120,
      surface: surface, rank_position: rank,
      viewport_visible: rank < 8,
      query_text: surface === 'search' ? user.favCategory : null,
      filters_active: null, dwell_time_ms: null,
      recommendation_source: 'heuristic', model_version: null,
      experiment_id: null, variant: null, propensity: 1,
      original_rank: rank, served_rank: rank,
      device_type: rnd() < 0.45 ? 'mobile' : 'desktop', metadata: {}
    });

    /* position discount: lower ranks are genuinely seen less often */
    const seen = rank < 6 ? 1 : Math.max(0.15, 1 - (rank - 6) * 0.12);
    if (rnd() > appeal(l, user) * seen) return;

    const add = (type, offsetMs, extra) => rows.push(Object.assign({
      event_id: 'ev_synth_' + rows.length, schema_version: 1,
      user_id: user.id, session_id: sessionId, listing_id: l.id,
      event_type: type, known_type: true,
      timestamp: sessionStart + rank * 120 + offsetMs,
      received_at: sessionStart + rank * 120 + offsetMs,
      surface: surface, rank_position: rank, viewport_visible: true,
      query_text: null, filters_active: null, dwell_time_ms: null,
      recommendation_source: 'heuristic', model_version: null,
      experiment_id: null, variant: null, propensity: 1,
      original_rank: rank, served_rank: rank, device_type: 'desktop', metadata: {}
    }, extra || {}));

    add('click', 4000);
    add('detail_view', 6000);
    if (rnd() < 0.45) add('dwell_30s', 38000, { dwell_time_ms: 31000 + Math.floor(rnd() * 40000) });
    if (rnd() < 0.34) add('save', 52000);
    if (rnd() < 0.16) add('message_sent', 70000, { metadata: { conversation_depth: 2 } });
    if (rnd() < 0.04) add('transaction_confirmed', 400000);
  });

  /* a few explicit dismissals */
  if (rnd() < 0.12) {
    const l = pick(pool);
    rows.push({
      event_id: 'ev_synth_' + rows.length, schema_version: 1,
      user_id: user.id, session_id: sessionId, listing_id: l.id,
      event_type: 'skip', known_type: true,
      timestamp: sessionStart + 90000, received_at: sessionStart + 90000,
      surface: surface, rank_position: pool.indexOf(l), viewport_visible: true,
      query_text: null, filters_active: null, dwell_time_ms: null,
      recommendation_source: 'heuristic', model_version: null,
      experiment_id: null, variant: null, propensity: 1,
      original_rank: null, served_rank: null, device_type: 'desktop', metadata: {}
    });
  }
}

rows.sort((a, b) => a.timestamp - b.timestamp);

const outDir = path.join(__dirname, 'generated');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'events.jsonl');
fs.writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const byType = {};
rows.forEach((r) => { byType[r.event_type] = (byType[r.event_type] || 0) + 1; });
const summary = {
  generated_at: new Date().toISOString(),
  synthetic: true,
  warning: 'SYNTHETIC FIXTURE — pipeline wiring only. No performance claim may cite this data.',
  sessions: SESSIONS,
  events: rows.length,
  unique_users: new Set(rows.map((r) => r.user_id)).size,
  unique_sessions: new Set(rows.map((r) => r.session_id)).size,
  unique_listings: new Set(rows.map((r) => r.listing_id)).size,
  by_type: byType,
  time_span_days: Math.round((rows[rows.length - 1].timestamp - rows[0].timestamp) / 86400000)
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(summary, null, 2));

console.log('Synthetic fixture written to ' + outFile);
Object.keys(summary).forEach((k) => console.log('  ' + k + ': ' + JSON.stringify(summary[k])));
console.log('\nNext (isolated from production data):');
console.log('  node ml/export_house_detail.js');
console.log('  TM_EVENT_LOG=ml/fixtures/generated/events.jsonl python ml/data/build_recommendation_dataset.py');
console.log('  python ml/training/train_ranker.py --allow-small');

module.exports = { rows, summary };
