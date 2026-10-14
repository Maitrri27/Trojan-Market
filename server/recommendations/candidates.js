/* Candidate generation — cheap recall before expensive scoring.

   Never scores the whole catalogue: assembles a bounded pool from several
   complementary sources, dedupes, and hands it to the ranker.
*/
const store = require('../lib/store');
const cfg = require('../lib/config');
const { HOUSE } = require('../data');

function isLive(l) { return !l.sold && !l.removed; }

function recent(limit) {
  return store.db.listings.filter(isLive).slice().sort((a, b) => (a.days || 0) - (b.days || 0)).slice(0, limit);
}

function trending(limit) {
  const counts = store.agg.listings || {};
  return store.db.listings.filter(isLive)
    .map((l) => ({ l: l, n: counts[l.id] || 0, v: l.views || 0 }))
    .sort((a, b) => (b.n * 3 + b.v) - (a.n * 3 + a.v))
    .slice(0, limit).map((x) => x.l);
}

function byCategories(cats, limit) {
  if (!cats.length) return [];
  return store.db.listings.filter((l) => isLive(l) && cats.indexOf(l.category) >= 0).slice(0, limit);
}

function byNeighborhoods(hoods, limit) {
  if (!hoods.length) return [];
  return store.db.listings.filter((l) => {
    const h = HOUSE[l.id];
    return isLive(l) && h && hoods.indexOf(h.hood) >= 0;
  }).slice(0, limit);
}

function similarTo(listingId, limit) {
  const seed = store.db.listings.filter((l) => l.id === listingId)[0];
  if (!seed) return [];
  const price = Number(seed.price) || 0;
  return store.db.listings
    .filter((l) => isLive(l) && l.id !== seed.id && l.category === seed.category)
    .map((l) => ({ l: l, d: Math.abs((Number(l.price) || 0) - price) }))
    .sort((a, b) => a.d - b.d).slice(0, limit).map((x) => x.l);
}

function inCategory(category, limit) {
  return store.db.listings.filter((l) => isLive(l) && l.category === category).slice(0, limit);
}

/**
 * @returns {{candidates: Array, sources: Object}} bounded, deduped pool
 */
function generate(opts) {
  const o = opts || {};
  const pool = cfg.REC_CANDIDATE_POOL;
  const prefs = o.preferences || {};
  const sources = {};
  const seen = new Set();
  const out = [];

  const push = (name, rows) => {
    let added = 0;
    rows.forEach((l) => {
      if (seen.has(l.id)) return;
      if ((o.excludeIds || []).indexOf(l.id) >= 0) return;
      seen.add(l.id); out.push(l); added++;
    });
    sources[name] = added;
  };

  if (o.surface === 'similar' && o.seedListingId) push('similar', similarTo(o.seedListingId, pool));
  if (o.surface === 'category' && o.category) push('category', inCategory(o.category, pool));

  push('affinity_categories', byCategories(prefs.top_categories || [], Math.floor(pool * 0.4)));
  push('affinity_neighborhoods', byNeighborhoods(prefs.top_neighborhoods || [], Math.floor(pool * 0.2)));
  push('trending', trending(Math.floor(pool * 0.3)));
  push('recent', recent(pool));

  return { candidates: out.slice(0, pool), sources: sources };
}

module.exports = { generate, recent, trending, similarTo, inCategory, isLive };
