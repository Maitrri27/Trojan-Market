/* User preference aggregation — the online feature store.

   Reads the append-only event log and the user's stated profile, and produces
   time-decayed behavioural statistics. Mirrors ml/features/recommendation_features.py;
   both must stay in sync (feature_version below is the contract).
*/
const store = require('../lib/store');
const { HOUSE, BLANK_PROFILE } = require('../data');

const FEATURE_VERSION = 'rec_features_v1';
const HALF_LIFE_DAYS = 14;

function decay(ts, now) {
  const days = (now - ts) / 86400000;
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

const WEIGHT = {
  impression: 0.05, click: 1, detail_view: 1, dwell_30s: 1.5,
  save: 3, message_sent: 4, offer_sent: 4, transaction_confirmed: 6, skip: -1.5
};

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {string|null} analyticsId pseudonymised user id
 * @param {string|null} email       for reading the stated profile only
 */
function aggregate(analyticsId, email) {
  const now = Date.now();
  const profile = (email && store.db.profiles[email]) || null;
  const listingsById = {};
  store.db.listings.forEach((l) => { listingsById[l.id] = l; });

  const cats = {};
  const hoods = {};
  const viewedPrices = [];
  const savedPrices = [];
  const searches = [];
  const recentCats = [];
  const skips = [];
  let interactions = 0;
  let firstSeen = now;

  if (analyticsId) {
    const rows = store.readEvents({ user_id: analyticsId });
    rows.forEach((ev) => {
      firstSeen = Math.min(firstSeen, ev.timestamp);
      const w = WEIGHT[ev.event_type];
      if (ev.event_type === 'search' && ev.query_text) searches.push(ev.query_text);
      if (ev.event_type === 'skip' && ev.listing_id) skips.push(ev.listing_id);
      if (w === undefined || !ev.listing_id) return;
      const l = listingsById[ev.listing_id];
      if (!l) return;
      const d = decay(ev.timestamp, now) * w;
      cats[l.category] = (cats[l.category] || 0) + d;
      const h = HOUSE[l.id];
      if (h) hoods[h.hood] = (hoods[h.hood] || 0) + d;
      if (w > 0) interactions++;
      if (['click', 'detail_view', 'dwell_30s'].indexOf(ev.event_type) >= 0) {
        viewedPrices.push(Number(l.price) || 0);
        recentCats.push(l.category);
      }
      if (ev.event_type === 'save') savedPrices.push(Number(l.price) || 0);
    });
  }

  /* legacy in-app behaviour blob still contributes until the event log fills */
  const legacy = (email && store.db.behavior[email]) || null;
  if (legacy) {
    Object.keys(legacy.cats || {}).forEach((k) => { cats[k] = (cats[k] || 0) + legacy.cats[k]; });
    Object.keys(legacy.hoods || {}).forEach((k) => { hoods[k] = (hoods[k] || 0) + legacy.hoods[k]; });
    (legacy.prices || []).forEach((p) => viewedPrices.push(p));
    (legacy.skips || []).forEach((s) => skips.push(s));
  }

  const total = Object.keys(cats).reduce((n, k) => n + Math.max(0, cats[k]), 0) || 1;
  const affinity = {};
  Object.keys(cats).forEach((k) => { affinity[k] = Math.max(0, cats[k]) / total; });

  const rank = (obj) => Object.keys(obj).sort((a, b) => obj[b] - obj[a]);

  return {
    feature_version: FEATURE_VERSION,
    analytics_id: analyticsId,
    has_history: interactions > 0,
    interaction_count: interactions,
    account_tenure_days: Math.round((now - firstSeen) / 86400000),
    category_affinity: affinity,
    top_categories: rank(affinity).slice(0, 3),
    top_neighborhoods: rank(hoods).slice(0, 2),
    median_viewed_price: median(viewedPrices),
    median_saved_price: median(savedPrices),
    recent_searches: searches.slice(-5),
    recent_categories: recentCats.slice(-8),
    skips: Array.from(new Set(skips)),
    stated: profile ? Object.assign({}, BLANK_PROFILE, profile) : null
  };
}

module.exports = { aggregate, FEATURE_VERSION, HALF_LIFE_DAYS, decay };
