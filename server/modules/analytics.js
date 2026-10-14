/* Analytics + ML dashboard data. Admin-facing. */
const http = require('../lib/http');
const store = require('../lib/store');
const log = require('../lib/log');
const cfg = require('../lib/config');
const registry = require('../ml/registry');
const inference = require('../ml/inference');
const events = require('../lib/events');

function funnel() {
  const t = store.agg.by_type || {};
  const impressions = t.impression || 0;
  const clicks = (t.click || 0) + (t.detail_view || 0);
  const saves = t.save || 0;
  const messages = t.message_sent || 0;
  const tx = t.transaction_confirmed || 0;
  const rate = (n) => (impressions ? Number((n / impressions).toFixed(5)) : null);
  return {
    impressions: impressions, clicks: clicks, saves: saves, messages: messages, transactions: tx,
    ctr: rate(clicks), save_rate: rate(saves), message_rate: rate(messages), transaction_rate: rate(tx)
  };
}

function datasetReadiness() {
  const t = store.agg.by_type || {};
  const users = Object.keys(store.agg.users || {}).length;
  const sessions = Object.keys(store.agg.sessions || {}).length;
  const positives = (t.click || 0) + (t.detail_view || 0) + (t.save || 0) + (t.message_sent || 0) + (t.transaction_confirmed || 0);
  const g = cfg.GATES;
  const checks = {
    training_examples: { actual: t.impression || 0, required: g.minimum_training_examples },
    unique_users: { actual: users, required: g.minimum_unique_users },
    unique_sessions: { actual: sessions, required: g.minimum_unique_sessions },
    positive_events: { actual: positives, required: g.minimum_positive_events }
  };
  Object.keys(checks).forEach((k) => { checks[k].satisfied = checks[k].actual >= checks[k].required; });
  const pct = Object.keys(checks).reduce((n, k) => n + Math.min(1, checks[k].actual / checks[k].required), 0) / 4;
  return { checks: checks, ready_to_train: Object.keys(checks).every((k) => checks[k].satisfied), progress: Number(pct.toFixed(3)) };
}

/* Shadow-vs-served comparison: rank correlation between what the heuristic
   served and what the shadow model would have served. */
function shadowComparison() {
  const rows = (store.db.recommendation_impressions || []).slice(-500);
  if (!rows.length) return { samples: 0, note: 'No shadow-mode traffic recorded yet.' };
  let agreeTop1 = 0, overlap5 = 0;
  rows.forEach((r) => {
    if (r.served_order[0] && r.served_order[0] === r.shadow_order[0]) agreeTop1++;
    const a = new Set(r.served_order.slice(0, 5));
    overlap5 += r.shadow_order.slice(0, 5).filter((x) => a.has(x)).length / 5;
  });
  return {
    samples: rows.length,
    top1_agreement: Number((agreeTop1 / rows.length).toFixed(3)),
    top5_overlap: Number((overlap5 / rows.length).toFixed(3)),
    model_version: rows[rows.length - 1].model_version,
    note: 'Shadow rankings were computed but never shown to users.'
  };
}

async function overview(ctx) {
  const t = store.agg.by_type || {};
  const days = Object.keys(store.agg.day || {}).sort().slice(-14).map((d) => ({ date: d, events: store.agg.day[d] }));
  const active = registry.active('recommendations');
  return http.ok(ctx.res, {
    marketplace: {
      listings: store.db.listings.length,
      live_listings: store.db.listings.filter((l) => !l.sold && !l.removed).length,
      users: Object.keys(store.db.users).length,
      conversations: store.db.threads.length,
      transactions: (store.db.transactions || []).length,
      open_reports: (store.db.reports || []).filter((r) => r.status === 'open').length
    },
    events: {
      total: store.eventTotal(),
      by_type: t,
      by_surface: store.agg.by_surface,
      unique_users: Object.keys(store.agg.users || {}).length,
      unique_sessions: Object.keys(store.agg.sessions || {}).length,
      daily: days
    },
    funnel: funnel(),
    recommendation_mode: registry.mode(),
    ml: {
      status: inference.status(),
      active_model: active,
      dataset_readiness: datasetReadiness(),
      shadow_comparison: shadowComparison(),
      gates: cfg.GATES
    },
    pipelines: {
      housing_pairwise: { collected: (store.db.housing_preference_pairs || []).length, minimum: 5000 },
      roommate_outcomes: { collected: (store.db.roommate_outcomes || []).length, minimum: 500 },
      fraud_labels: { collected: (store.db.moderation_decisions || []).length, minimum: 1000 }
    },
    observability: log.snapshot()
  });
}

/* Experiment read-out: per-variant funnel from raw events. */
async function experimentResults(ctx) {
  const id = ctx.params[0];
  const rows = store.readEvents({});
  const variants = {};
  rows.forEach((ev) => {
    if (ev.experiment_id !== id) return;
    const v = ev.variant || 'unassigned';
    variants[v] = variants[v] || { impressions: 0, clicks: 0, saves: 0, messages: 0, transactions: 0 };
    const b = variants[v];
    if (ev.event_type === 'impression') b.impressions++;
    if (ev.event_type === 'click' || ev.event_type === 'detail_view') b.clicks++;
    if (ev.event_type === 'save') b.saves++;
    if (ev.event_type === 'message_sent') b.messages++;
    if (ev.event_type === 'transaction_confirmed') b.transactions++;
  });
  Object.keys(variants).forEach((k) => {
    const b = variants[k];
    const i = b.impressions || 1;
    b.ctr = Number((b.clicks / i).toFixed(5));
    b.save_rate = Number((b.saves / i).toFixed(5));
    b.message_rate = Number((b.messages / i).toFixed(5));
    b.transaction_rate = Number((b.transactions / i).toFixed(5));
  });
  const exp = (store.db.experiments || []).filter((e) => e.experiment_id === id)[0] || null;
  return http.ok(ctx.res, {
    experiment: exp, variants: variants,
    note: 'Judge on save/message/transaction rate, not CTR alone — clicks can rise while real outcomes fall.'
  });
}

/* Export the raw log for the offline pipeline. */
async function exportTraining(ctx) {
  const rows = store.readEvents({ since: ctx.url.searchParams.get('since') ? Number(ctx.url.searchParams.get('since')) : null });
  const ndjson = rows.map((r) => JSON.stringify(r)).join('\n');
  ctx.res.writeHead(200, Object.assign({
    'Content-Type': 'application/x-ndjson',
    'Content-Disposition': 'attachment; filename="events.jsonl"'
  }, http.CORS));
  ctx.res.end(ndjson);
}

async function health(ctx) {
  return http.ok(ctx.res, {
    ok: true,
    listings: store.db.listings.length,
    categories: Object.keys(require('../data').CATKW),
    events_logged: store.eventTotal(),
    recommendation_mode: registry.mode(),
    schema_version: store.db.schema_version,
    event_types: events.KNOWN.length
  });
}

module.exports = {
  funnel, datasetReadiness, shadowComparison,
  routes: [
    { method: 'GET', path: '/api/health', handler: health },
    { method: 'GET', path: '/api/admin/overview', handler: overview, opts: { admin: true } },
    { method: 'GET', path: /^\/api\/admin\/experiments\/([\w-]+)\/results$/, handler: experimentResults, opts: { admin: true } },
    { method: 'GET', path: '/api/admin/export/events', handler: exportTraining, opts: { admin: true } }
  ]
};
