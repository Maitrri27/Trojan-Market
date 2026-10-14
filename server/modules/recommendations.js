/* Recommendation API. The frontend calls this and nothing else — it never
   knows whether a heuristic or an ML model produced the ordering. */
const http = require('../lib/http');
const store = require('../lib/store');
const ranker = require('../recommendations/ranker');
const preferences = require('../recommendations/preferences');
const registry = require('../ml/registry');
const inference = require('../ml/inference');
const roommates = require('./roommates');
const { ROOMMATES, BLANK_PROFILE } = require('../data');

function publicMeta(meta, isAdmin) {
  /* ordinary users see the mode and version only — not gate internals,
     candidate source mix, or failure reasons */
  if (isAdmin) return meta;
  return {
    source: meta.source,
    model_version: meta.model_version,
    cold_start: meta.cold_start,
    latency_ms: meta.latency_ms
  };
}

async function recommend(ctx) {
  const b = ctx.method === 'POST' ? await http.readBody(ctx.req) : {};
  const s = ctx.url.searchParams;
  const opts = {
    user: ctx.user,
    analyticsId: ctx.analyticsId,
    sessionId: b.session_id || s.get('session_id'),
    surface: b.surface || s.get('surface') || 'foryou',
    limit: Number(b.limit || s.get('limit')) || undefined,
    category: b.category || s.get('category'),
    query: b.query_text || s.get('q'),
    filters: b.filters_active || null,
    seedListingId: b.seed_listing_id || s.get('seed_listing_id'),
    device: b.device_type || s.get('device') || null,
    logImpressions: b.log_impressions !== false
  };
  const out = await ranker.rank(opts);
  return http.ok(ctx.res, {
    recommendations: out.recommendations.map((r) => ({
      listing_id: r.listing_id,
      listing: r.listing,
      score: r.score,
      source: r.source,
      model_version: r.model_version,
      rank_position: r.rank_position,
      why: r.explanation
    })),
    meta: publicMeta(out.meta, ctx.isAdmin)
  });
}

/* Combined feed used by the app: listings + roommate suggestions. */
async function foryou(ctx) {
  const s = ctx.url.searchParams;
  const out = await ranker.rank({
    user: ctx.user, analyticsId: ctx.analyticsId,
    sessionId: s.get('session_id'), surface: 'foryou',
    limit: Number(s.get('limit')) || 5, device: s.get('device')
  });
  const profile = (ctx.user && store.db.profiles[ctx.user.email]) || BLANK_PROFILE;
  const roommateMatches = ROOMMATES
    .map((r) => ({ roommate: r, match: roommates.compatibility(profile, r).score }))
    .sort((a, b) => b.match - a.match).slice(0, 3);
  return http.ok(ctx.res, {
    listings: out.recommendations,
    roommates: roommateMatches,
    meta: publicMeta(out.meta, ctx.isAdmin)
  });
}

async function features(ctx) {
  const prefs = preferences.aggregate(ctx.analyticsId, ctx.user.email);
  return http.ok(ctx.res, { features: prefs });
}

async function status(ctx) {
  return http.ok(ctx.res, {
    mode: registry.mode(),
    ml: inference.status(),
    heuristic: { always_available: true, weights: require('../recommendations/heuristic_ranker').WEIGHTS },
    models: registry.list('recommendations').map((m) => ({
      model_id: m.model_id, version: m.version, status: m.status,
      algorithm: m.algorithm, training_timestamp: m.training_timestamp,
      metrics: m.metrics, gates: registry.checkGates(m)
    }))
  });
}

module.exports = {
  routes: [
    { method: 'GET', path: '/api/recommendations', handler: recommend },
    { method: 'POST', path: '/api/recommendations', handler: recommend },
    { method: 'GET', path: '/api/recommendations/foryou', handler: foryou },
    { method: 'GET', path: '/api/recommendations/features', handler: features, opts: { auth: true } },
    { method: 'GET', path: '/api/recommendations/status', handler: status }
  ]
};
