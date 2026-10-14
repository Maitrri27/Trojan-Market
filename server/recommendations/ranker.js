/* THE ranking interface. Everything user-facing calls rank() and nothing else.

   candidate generation -> features -> heuristic score -> ML score (if valid)
   -> blend -> exploration -> impression logging

   Replacing the ML model changes nothing above this file, and nothing in the
   frontend.
*/
const cfg = require('../lib/config');
const log = require('../lib/log');
const store = require('../lib/store');
const events = require('../lib/events');
const candidates = require('./candidates');
const heuristic = require('./heuristic_ranker');
const preferences = require('./preferences');
const inference = require('../ml/inference');
const registry = require('../ml/registry');
const experiments = require('../experiments/experiments');
const { HOUSE } = require('../data');

/* seller reliability stats, refreshed by the background worker */
let sellerStats = {};
function refreshSellerStats() {
  const s = {};
  store.db.listings.forEach((l) => {
    const k = l.email; if (!k) return;
    s[k] = s[k] || { listings: 0, threads: 0, replies: 0, reports: 0 };
    s[k].listings++;
  });
  (store.db.threads || []).forEach((t) => {
    const owner = t.email; if (!owner || !s[owner]) return;
    s[owner].threads++;
    if ((t.messages || []).some((m) => m.from === owner)) s[owner].replies++;
  });
  (store.db.reports || []).forEach((r) => {
    const l = store.db.listings.filter((x) => x.id === r.listingId)[0];
    if (l && s[l.email]) s[l.email].reports++;
  });
  sellerStats = s;
  return s;
}
refreshSellerStats();

/** Feature row handed to the ML service. Must match ml/features/ contract. */
function featureRow(entry, prefs, ctx, position) {
  const l = entry.listing;
  const h = HOUSE[l.id] || null;
  const price = Number(l.price) || 0;
  const med = prefs.median_viewed_price;
  return {
    listing_id: l.id,
    /* listing */
    price: price,
    is_free: l.free ? 1 : 0,
    category: l.category,
    listing_age_days: l.days === undefined ? 7 : l.days,
    photo_count: l.photo ? 1 : (l.kw ? 1 : 0),
    description_length: String(l.description || '').length,
    has_condition: l.condition && l.condition !== '—' ? 1 : 0,
    neighborhood: h ? h.hood : null,
    commute_minutes: h ? h.commute : null,
    bedrooms: h ? h.beds : null,
    bathrooms: h ? h.baths : null,
    furnished: h ? (h.furnished ? 1 : 0) : null,
    historical_view_rate: l.views || 0,
    seller_reliability: heuristic.components.sellerReliability(l, sellerStats),
    /* user */
    user_interaction_count: prefs.interaction_count,
    user_tenure_days: prefs.account_tenure_days,
    user_median_viewed_price: med,
    /* cross */
    category_affinity: (prefs.category_affinity || {})[l.category] || 0,
    category_match: (prefs.top_categories || []).indexOf(l.category) >= 0 ? 1 : 0,
    price_diff_from_user_median: med === null || med === undefined ? null : price - med,
    price_within_user_range: prefs.stated ? (price >= prefs.stated.budgetMin && price <= prefs.stated.budgetMax ? 1 : 0) : null,
    neighborhood_match: h && prefs.stated ? (h.hood === prefs.stated.hood ? 1 : 0) : null,
    /* context */
    surface: ctx.surface,
    has_query: ctx.query ? 1 : 0,
    filter_count: ctx.filters ? Object.keys(ctx.filters).length : 0,
    hour_of_day: new Date().getHours(),
    day_of_week: new Date().getDay(),
    device_type: ctx.device || 'unknown',
    /* bias correction only — never a relevance feature at serving time */
    rank_position: position,
    /* heuristic score is a legitimate input feature for the ranker */
    heuristic_score: entry.heuristic_score
  };
}

function normaliseScores(entries, key) {
  const vals = entries.map((e) => e[key]).filter((v) => typeof v === 'number');
  if (!vals.length) return;
  const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  const span = max - min || 1;
  entries.forEach((e) => { e[key + '_norm'] = typeof e[key] === 'number' ? (e[key] - min) / span : 0; });
}

/**
 * Main entry point.
 * @param {Object} opts { user, analyticsId, surface, limit, category, query,
 *                        filters, seedListingId, sessionId, device, logImpressions }
 */
async function rank(opts) {
  const done = log.timer('recommendations.rank');
  const o = opts || {};
  const surface = o.surface || 'foryou';
  const limit = Math.max(1, Math.min(100, o.limit || cfg.REC_DEFAULT_LIMIT));

  const prefs = preferences.aggregate(o.analyticsId, o.user ? o.user.email : null);
  const cold = !prefs.has_history;

  const pool = candidates.generate({
    surface: surface,
    category: o.category,
    seedListingId: o.seedListingId,
    preferences: prefs,
    excludeIds: (prefs.skips || []).concat(o.excludeIds || [])
  });

  let ranked = heuristic.rank(pool.candidates, prefs, {
    category: o.category,
    eventCounts: store.agg.listings,
    sellerStats: sellerStats
  });

  /* ---- ML scoring: additive, optional, never load-bearing ---- */
  const assignment = experiments.assign(o.analyticsId || 'anon', surface);
  const variant = assignment ? assignment.variant : null;
  const mlStatus = inference.available();
  let mlResult = null;
  let mode = 'heuristic';
  let modelVersion = null;
  let effectiveWeight = 0;

  const shortlist = ranked.slice(0, Math.min(ranked.length, Math.max(limit * 3, 60)));

  if (mlStatus.ok) {
    const rows = shortlist.map((e, i) => featureRow(e, prefs, { surface: surface, query: o.query, filters: o.filters, device: o.device }, i));
    mlResult = await inference.score(rows, { surface: surface, user_cold_start: cold });
    if (mlResult) {
      modelVersion = mlResult.model_version;
      const model = registry.active('recommendations');
      const isActive = model && model.version === modelVersion && model.status === 'active';
      /* shadow mode: compute + log, but do NOT influence what the user sees */
      const shadowOnly = !isActive || (variant && variant === 'heuristic');
      shortlist.forEach((e) => { e.ml_score = mlResult.scores[e.listing.id]; });
      normaliseScores(shortlist, 'heuristic_score');
      normaliseScores(shortlist, 'ml_score');
      if (shadowOnly) {
        mode = 'shadow_ml';
        shortlist.forEach((e) => { e.shadow_rank_score = e.ml_score_norm; });
      } else {
        effectiveWeight = cfg.ML_MODEL_WEIGHT;
        mode = effectiveWeight >= 1 ? 'ml_active' : 'ml_blend';
        shortlist.forEach((e) => {
          e.blended_score = (1 - effectiveWeight) * (e.heuristic_score_norm || 0) + effectiveWeight * (e.ml_score_norm || 0);
        });
        shortlist.sort((a, b) => b.blended_score - a.blended_score);
        ranked = shortlist.concat(ranked.slice(shortlist.length));
      }
    }
  }

  /* ---- controlled exploration for position-bias correction ---- */
  const exploration = experiments.explore(ranked.slice(0, limit), o.analyticsId || 'anon');
  const finalRows = exploration.rows;

  const recommendations = finalRows.map((e, i) => ({
    listing_id: e.listing.id,
    listing: e.listing,
    score: Number((e.blended_score !== undefined ? e.blended_score : e.heuristic_score).toFixed(6)),
    source: mode === 'heuristic' || mode === 'shadow_ml' ? 'heuristic' : 'ml_ranker',
    model_version: mode === 'ml_active' || mode === 'ml_blend' ? modelVersion : null,
    rank_position: i,
    original_rank: exploration.explored ? ranked.indexOf(e) : i,
    explanation: explain(e, prefs)
  }));

  /* ---- mandatory impression logging: one row per listing SHOWN ---- */
  if (o.logImpressions !== false) {
    const rows = recommendations.map((r) => ({
      event_type: 'impression',
      user_id: o.analyticsId,
      session_id: o.sessionId,
      listing_id: r.listing_id,
      surface: surface,
      rank_position: r.rank_position,
      original_rank: r.original_rank,
      served_rank: r.rank_position,
      query_text: o.query || null,
      filters_active: o.filters || null,
      recommendation_source: r.source,
      model_version: r.model_version,
      experiment_id: assignment ? assignment.experiment_id : null,
      variant: variant,
      propensity: exploration.propensity,
      device_type: o.device || null
    }));
    events.ingest(rows, { userId: o.analyticsId });
  }

  /* shadow comparison log — how would the model have ranked? */
  if (mode === 'shadow_ml' && mlResult) {
    const shadowOrder = shortlist.slice().sort((a, b) => (b.ml_score || 0) - (a.ml_score || 0)).slice(0, limit).map((e) => e.listing.id);
    store.db.recommendation_impressions.push({
      at: Date.now(), surface: surface, user_id: o.analyticsId,
      served_order: recommendations.map((r) => r.listing_id),
      shadow_order: shadowOrder, model_version: modelVersion
    });
    if (store.db.recommendation_impressions.length > 5000) store.db.recommendation_impressions.shift();
    store.save();
  }

  const latency = done();
  return {
    recommendations: recommendations,
    meta: {
      mode: mode,
      registry_mode: registry.mode(),
      source: mode === 'ml_active' || mode === 'ml_blend' ? 'ml_ranker' : 'heuristic',
      model_version: modelVersion,
      model_weight: effectiveWeight,
      ml_unavailable_reason: mlStatus.ok ? null : mlStatus.reason,
      cold_start: cold,
      feature_version: prefs.feature_version,
      candidate_count: pool.candidates.length,
      candidate_sources: pool.sources,
      experiment_id: assignment ? assignment.experiment_id : null,
      variant: variant,
      exploration: exploration.explored ? { swapped: exploration.swapped, propensity: exploration.propensity } : null,
      latency_ms: latency
    }
  };
}

/** Human-readable reason, built from heuristic components (never from the ML
    model — gradient-boosted scores are not explanations). */
function explain(entry, prefs) {
  const c = entry.components || {};
  const out = [];
  if (c.category_relevance > 0.7 && prefs.has_history) out.push('matches categories you browse');
  if (c.price_relevance > 0.8) out.push('in your usual price range');
  if (c.location_relevance > 0.75) out.push('near your preferred area');
  if (c.recency > 0.8) out.push('posted recently');
  if (c.popularity > 0.7) out.push('popular with other students');
  if (!out.length) out.push('new on the marketplace');
  return out.slice(0, 3);
}

module.exports = { rank, refreshSellerStats, featureRow, explain, sellerStats: () => sellerStats };
