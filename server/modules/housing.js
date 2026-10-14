/* Housing: filters, transparent House Match, and pairwise preference capture.

   House Match is explicitly heuristic and explains itself. The Bradley-Terry
   model in ml/housing/ replaces the WEIGHTS only once enough pairwise
   preferences exist — see ml/housing/README.md.
*/
const http = require('../lib/http');
const store = require('../lib/store');
const events = require('../lib/events');
const { HOUSE, BLANK_PROFILE } = require('../data');

/* Default weights. Overridden by a fitted Bradley-Terry vector if one has been
   promoted in ml/artifacts/housing_weights.json. */
const DEFAULT_WEIGHTS = {
  budget: 30, commute: 15, neighborhood: 15, pets: 10, furnished: 10, lease: 10, bedrooms: 10
};

let fittedWeights = null;
function loadFittedWeights() {
  try {
    const path = require('path');
    const fs = require('fs');
    const cfg = require('../lib/config');
    const f = path.join(cfg.MODEL_DIR, 'housing_weights.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    /* only trust a promoted, gated artifact */
    if (raw && raw.status === 'active' && raw.weights) { fittedWeights = raw; return raw; }
  } catch (e) {}
  fittedWeights = null;
  return null;
}
loadFittedWeights();

function weights() { return (fittedWeights && fittedWeights.weights) || DEFAULT_WEIGHTS; }
function weightSource() { return fittedWeights ? { source: 'bradley_terry', version: fittedWeights.version, n_pairs: fittedWeights.n_pairs } : { source: 'heuristic', version: null }; }

function band(score) { return score >= 80 ? 'High Match' : score >= 60 ? 'Medium Match' : 'Low Match'; }

function houseScore(p, listing) {
  const h = HOUSE[listing.id];
  if (!h) return null;
  const w = weights();
  const rows = [];
  const add = (key, value, ok, text) => rows.push({ criterion: key, weight: w[key], value: value, ok: ok, text: text });

  const over = h.rent - p.budgetMax;
  add('budget', over <= 0 ? 1 : Math.max(0, 1 - over / 600), over <= 0,
    over <= 0 ? 'Within budget ($' + h.rent + '/mo)' : '$' + over + ' over budget');
  add('commute', h.commute <= p.commuteMax ? 1 : Math.max(0, 1 - (h.commute - p.commuteMax) / 20),
    h.commute <= p.commuteMax, h.commute + '-minute commute');
  add('neighborhood', h.hood === p.hood ? 1 : 0.35, h.hood === p.hood,
    h.hood === p.hood ? 'Preferred neighborhood' : h.hood);
  const petsOk = !p.pets || h.pets;
  add('pets', petsOk ? 1 : 0, petsOk, h.pets ? 'Pet-friendly' : (petsOk ? 'No pets — matches your preference' : 'No pets allowed'));
  add('furnished', !p.furnished || h.furnished ? 1 : 0.2, !p.furnished || h.furnished, h.furnished ? 'Furnished' : 'Unfurnished');
  add('lease', Math.abs(h.lease - p.lease) <= 2 ? 1 : 0.4, Math.abs(h.lease - p.lease) <= 2,
    h.lease + '-month lease · available ' + h.moveIn);
  add('bedrooms', h.beds >= p.beds ? 1 : 0.5, h.beds >= p.beds, h.beds + ' bed · ' + h.baths + ' bath · ' + h.type);

  const total = rows.reduce((n, r) => n + r.weight, 0) || 1;
  const raw = rows.reduce((n, r) => n + r.weight * r.value, 0);
  const score = Math.round((raw / total) * 100);
  return { score: score, band: band(score), rows: rows, amenities: h.amenities, model: weightSource() };
}

function profileOf(ctx) {
  return (ctx.user && store.db.profiles[ctx.user.email]) || BLANK_PROFILE;
}

async function filter(ctx) {
  const s = ctx.url.searchParams;
  const num = (k, d) => (s.get(k) === null ? d : Number(s.get(k)));
  const f = {
    rentMin: num('rentMin', 0), rentMax: num('rentMax', 99999), distance: num('distance', 999),
    beds: s.get('beds'), baths: s.get('baths'), availability: s.get('availability'),
    furnishing: s.get('furnishing'), lease: s.get('lease'), gender: s.get('gender'), food: s.get('food'),
    amenities: (s.get('amenities') || '').split(',').filter(Boolean)
  };
  const profile = profileOf(ctx);
  const out = store.db.listings.filter((l) => {
    const d = HOUSE[l.id];
    if (!d || l.removed) return false;
    if (d.rent < f.rentMin || d.rent > f.rentMax) return false;
    if (d.commute > f.distance) return false;
    if (f.beds && f.beds !== 'any' && d.beds < Number(f.beds)) return false;
    if (f.baths && f.baths !== 'any' && d.baths < Number(f.baths)) return false;
    if (f.furnishing && f.furnishing !== 'any' && (f.furnishing === 'furnished') !== !!d.furnished) return false;
    if (f.lease && f.lease !== 'any' && !(f.lease === 'short' ? d.lease <= 6 : d.lease >= 9)) return false;
    /* Gender and dietary preference are HARD USER-SET FILTERS only.
       They are never features of any learned model — see docs/FAIR_HOUSING.md */
    if (f.gender && f.gender !== 'any' && d.gender !== 'Any' && d.gender !== f.gender) return false;
    if (f.food && f.food !== 'any' && d.food !== 'Any' && d.food.toLowerCase().indexOf(f.food.toLowerCase()) < 0) return false;
    if (f.availability && f.availability !== 'any') {
      const fall = ['Jul', 'Aug', 'Sep'].indexOf(String(d.moveIn).split(' ')[0]) >= 0;
      if (f.availability === 'fall' && !fall) return false;
      if (f.availability === 'spring' && fall) return false;
    }
    if (f.amenities.length && !f.amenities.every((a) =>
      d.amenities.some((x) => x.toLowerCase().indexOf(a.toLowerCase()) >= 0) || (a === 'Pet-friendly' && d.pets))) return false;
    return true;
  }).map((l) => {
    const h = houseScore(profile, l);
    return { listing: l, detail: HOUSE[l.id], match: h ? h.score : null, band: h ? h.band : null };
  }).sort((a, b) => (b.match || 0) - (a.match || 0));

  events.emit('filter_applied', {
    user_id: ctx.analyticsId, surface: 'housing',
    filters_active: f, metadata: { result_count: out.length }
  }, { userId: ctx.analyticsId });

  return http.ok(ctx.res, { count: out.length, homes: out, filters: f, scoring: weightSource() });
}

async function match(ctx) {
  const l = store.db.listings.filter((x) => x.id === ctx.params[0])[0];
  if (!l) return http.notFound(ctx.res, 'Listing not found.');
  const h = houseScore(profileOf(ctx), l);
  if (!h) return http.ok(ctx.res, { match: null, note: 'House Match applies to housing listings.' });
  return http.ok(ctx.res, { match: h.score, band: h.band, checks: h.rows, amenities: h.amenities, scoring: h.model });
}

/* ---------------- pairwise preference collection (feeds Bradley-Terry) ---- */

async function pairwiseNext(ctx) {
  const ids = Object.keys(HOUSE);
  const seen = (store.db.housing_preference_pairs || [])
    .filter((p) => p.user_id === ctx.analyticsId)
    .map((p) => [p.option_a, p.option_b].sort().join('|'));
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = [ids[i], ids[j]].sort().join('|');
      if (seen.indexOf(key) < 0) pairs.push([ids[i], ids[j]]);
    }
  }
  if (!pairs.length) return http.ok(ctx.res, { pair: null, note: 'All pairs answered — thank you.' });
  const pick = pairs[Math.floor(Math.random() * pairs.length)];
  const byId = (id) => {
    const l = store.db.listings.filter((x) => x.id === id)[0];
    return { listing_id: id, listing: l, detail: HOUSE[id] };
  };
  events.emit('pairwise_shown', { user_id: ctx.analyticsId, surface: 'housing', metadata: { a: pick[0], b: pick[1] } }, { userId: ctx.analyticsId });
  return http.ok(ctx.res, {
    pair: { option_a: byId(pick[0]), option_b: byId(pick[1]) },
    answered: seen.length, remaining: pairs.length
  });
}

async function pairwiseAnswer(ctx) {
  const b = await http.readBody(ctx.req);
  const errs = http.validate(b, {
    option_a: { type: 'string', required: true },
    option_b: { type: 'string', required: true },
    selected_option: { type: 'string', required: true, enum: ['a', 'b', 'none', 'skip'] }
  });
  if (errs) return http.badRequest(ctx.res, 'Invalid preference.', errs);
  const row = {
    pair_id: 'pp' + Date.now() + Math.random().toString(36).slice(2, 5),
    user_id: ctx.analyticsId,
    option_a: b.option_a, option_b: b.option_b,
    selected_option: b.selected_option,
    timestamp: Date.now()
  };
  store.db.housing_preference_pairs.push(row);
  store.save();
  events.emit(b.selected_option === 'skip' ? 'pairwise_skip' : 'pairwise_choice', {
    user_id: ctx.analyticsId, surface: 'housing',
    metadata: { a: b.option_a, b: b.option_b, chose: b.selected_option }
  }, { userId: ctx.analyticsId });
  return http.created(ctx.res, { recorded: row.pair_id, total_pairs: store.db.housing_preference_pairs.length });
}

async function pairwiseStats(ctx) {
  const rows = store.db.housing_preference_pairs || [];
  const decisive = rows.filter((r) => r.selected_option === 'a' || r.selected_option === 'b');
  const users = new Set(rows.map((r) => r.user_id).filter(Boolean));
  const MIN = 5000;
  return http.ok(ctx.res, {
    total_pairs: rows.length,
    decisive_pairs: decisive.length,
    unique_users: users.size,
    minimum_for_training: MIN,
    ready_to_train: decisive.length >= MIN,
    current_scoring: weightSource()
  });
}

module.exports = {
  houseScore, weights, weightSource, loadFittedWeights, DEFAULT_WEIGHTS,
  routes: [
    { method: 'GET', path: '/api/housing', handler: filter },
    { method: 'GET', path: /^\/api\/listings\/([\w-]+)\/match$/, handler: match },
    { method: 'GET', path: '/api/housing/pairwise/next', handler: pairwiseNext, opts: { auth: true } },
    { method: 'POST', path: '/api/housing/pairwise', handler: pairwiseAnswer, opts: { auth: true } },
    { method: 'GET', path: '/api/housing/pairwise/stats', handler: pairwiseStats }
  ]
};
