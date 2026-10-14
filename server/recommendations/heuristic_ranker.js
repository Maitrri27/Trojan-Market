/* Heuristic ranker — the permanent fallback and the cold-start ranker.

   Fully functional with zero ML and zero behavioural data. Weights are
   configurable so they can be tuned (or, later, fitted) without code changes.
*/
const { HOUSE } = require('../data');

const WEIGHTS = {
  category_relevance: 0.24,
  price_relevance: 0.16,
  location_relevance: 0.14,
  recency: 0.16,
  listing_quality: 0.12,
  popularity: 0.10,
  seller_reliability: 0.08
};

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function categoryRelevance(listing, prefs, ctx) {
  if (ctx && ctx.category) return listing.category === ctx.category ? 1 : 0.2;
  const aff = (prefs.category_affinity || {})[listing.category];
  if (aff === undefined) return 0.5;                 // unknown -> neutral
  return clamp01(0.35 + aff * 1.6);
}

function priceRelevance(listing, prefs) {
  const price = Number(listing.price) || 0;
  const stated = prefs.stated;
  if (stated && listing.category === 'housing') {
    const h = HOUSE[listing.id];
    const rent = h ? h.rent : price;
    if (rent <= stated.budgetMax && rent >= stated.budgetMin * 0.6) return 1;
    const over = rent - stated.budgetMax;
    return clamp01(1 - Math.max(0, over) / 600);
  }
  const med = prefs.median_saved_price !== null && prefs.median_saved_price !== undefined
    ? prefs.median_saved_price : prefs.median_viewed_price;
  if (med === null || med === undefined) return listing.free || price === 0 ? 0.7 : 0.5;
  return clamp01(1 - Math.abs(price - med) / (med + 250));
}

function locationRelevance(listing, prefs) {
  const h = HOUSE[listing.id];
  if (!h) return 0.5;
  const stated = prefs.stated;
  let s = 0.4;
  if (stated) {
    if (h.hood === stated.hood) s += 0.4;
    s += 0.2 * clamp01(1 - h.commute / Math.max(1, stated.commuteMax * 2));
  }
  if ((prefs.top_neighborhoods || []).indexOf(h.hood) >= 0) s += 0.2;
  return clamp01(s);
}

function recency(listing) {
  const days = listing.days === undefined ? 7 : listing.days;
  return clamp01(Math.pow(0.85, days));       // ~half-life of 4 days
}

function listingQuality(listing) {
  let s = 0;
  s += listing.photo ? 0.35 : (listing.kw ? 0.2 : 0);
  const dlen = String(listing.description || '').length;
  s += clamp01(dlen / 220) * 0.3;
  s += listing.condition && listing.condition !== '—' ? 0.15 : 0;
  s += listing.location ? 0.1 : 0;
  s += HOUSE[listing.id] ? 0.1 : 0;
  return clamp01(s);
}

function popularity(listing, stats) {
  const views = listing.views || 0;
  const evs = (stats && stats[listing.id]) || 0;
  return clamp01(Math.log10(1 + views + evs * 3) / 3);
}

function sellerReliability(listing, sellers) {
  const s = sellers && sellers[listing.email];
  if (!s) return 0.55;
  let score = 0.4;
  score += clamp01(s.listings / 8) * 0.2;
  score += clamp01(s.replies / Math.max(1, s.threads)) * 0.3;
  score -= clamp01((s.reports || 0) / 3) * 0.4;
  return clamp01(score);
}

/**
 * @returns {Array<{listing, heuristic_score, components}>} descending by score
 */
function rank(candidates, prefs, ctx) {
  const stats = (ctx && ctx.eventCounts) || {};
  const sellers = (ctx && ctx.sellerStats) || {};
  const w = Object.assign({}, WEIGHTS, (ctx && ctx.weights) || {});

  return candidates.map((l) => {
    const c = {
      category_relevance: categoryRelevance(l, prefs, ctx),
      price_relevance: priceRelevance(l, prefs),
      location_relevance: locationRelevance(l, prefs),
      recency: recency(l),
      listing_quality: listingQuality(l),
      popularity: popularity(l, stats),
      seller_reliability: sellerReliability(l, sellers)
    };
    let score = 0;
    Object.keys(w).forEach((k) => { score += w[k] * (c[k] || 0); });
    return { listing: l, heuristic_score: Number(score.toFixed(6)), components: c };
  }).sort((a, b) => b.heuristic_score - a.heuristic_score);
}

module.exports = { rank, WEIGHTS, components: { categoryRelevance, priceRelevance, locationRelevance, recency, listingQuality, popularity, sellerReliability } };
