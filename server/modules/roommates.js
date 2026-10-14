/* Roommate compatibility — transparent heuristic ONLY.

   No learned model is used and none will be until real cohabitation outcomes
   exist (see /api/roommates/outcomes/stats for the counter). Any future model
   must use symmetric features and must not consume protected attributes.
*/
const http = require('../lib/http');
const store = require('../lib/store');
const events = require('../lib/events');
const { ROOMMATES, BLANK_PROFILE } = require('../data');

/* Criteria. Every one is an EXPLICITLY STATED, non-protected lifestyle
   preference. Gender/age/religion/ethnicity are deliberately absent. */
const CRITERIA = [
  { key: 'budget', w: 25, yes: 'similar budgets', no: 'different budget ranges' },
  { key: 'neighborhood', w: 15, yes: 'the same preferred neighborhood', no: 'different preferred areas' },
  { key: 'cleanliness', w: 15, yes: 'matching cleanliness standards', no: 'different cleanliness habits' },
  { key: 'sleep', w: 10, yes: 'the same sleep schedule', no: 'opposite sleep schedules' },
  { key: 'noise', w: 10, yes: 'similar noise tolerance', no: 'different noise levels' },
  { key: 'smoking', w: 8, yes: 'aligned smoking preferences', no: 'a smoking mismatch' },
  { key: 'pets', w: 7, yes: 'the same take on pets', no: 'a pet mismatch' },
  { key: 'social', w: 5, yes: 'a similar social/private balance', no: 'different social styles' },
  { key: 'timing', w: 5, yes: 'the same lease length and move-in window', no: 'different move-in timing' }
];

function overlap(a, b) {
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
  if (hi < lo) return 0;
  const span = Math.min(a[1] - a[0], b[1] - b[0]) || 1;
  return Math.min(1, (hi - lo) / span);
}

/* Symmetric by construction: uses |a-b|, equality and interval overlap only,
   never raw ordered values, so score(a,b) === score(b,a). */
function compatibility(p, r) {
  const near = (a, b) => 1 - Math.min(1, Math.abs(a - b) / 4);
  const v = {
    budget: overlap([p.budgetMin, p.budgetMax], r.budget),
    neighborhood: p.hood === r.hood ? 1 : 0.25,
    cleanliness: near(p.clean, r.clean),
    sleep: p.sleep === r.sleep ? 1 : 0.2,
    noise: near(p.noise, r.noise),
    smoking: p.smoking === r.smoking ? 1 : 0,
    pets: p.pets === r.pets ? 1 : 0.3,
    social: near(p.social, r.social),
    timing: (p.lease === r.lease ? 0.6 : 0.2) + (p.moveIn === r.moveIn ? 0.4 : 0)
  };
  let score = 0;
  CRITERIA.forEach((c) => { score += c.w * v[c.key]; });
  return {
    score: Math.min(98, Math.round(score)),
    values: v,
    strong: CRITERIA.filter((c) => v[c.key] >= 0.75).sort((a, b) => b.w - a.w).map((c) => c.yes),
    weak: CRITERIA.filter((c) => v[c.key] < 0.4).sort((a, b) => b.w - a.w).map((c) => c.no)
  };
}

async function list(ctx) {
  const profile = (ctx.user && store.db.profiles[ctx.user.email]) || BLANK_PROFILE;
  const scored = ROOMMATES.map((r) => {
    const s = compatibility(profile, r);
    const article = /^(8|11|18)/.test(String(s.score)) ? 'an ' : 'a ';
    return Object.assign({}, r, {
      match: s.score, reasons: s.strong, mismatches: s.weak,
      summary: 'You are ' + article + s.score + '% match with ' + r.name.split(' ')[0] +
        ' because you have ' + (s.strong.slice(0, 3).join(', ') || 'a few things in common') + '.'
    });
  }).sort((a, b) => b.match - a.match);
  return http.ok(ctx.res, {
    roommates: scored,
    scoring: { method: 'transparent_heuristic', model: null, note: 'No learned model — insufficient cohabitation outcome data.' }
  });
}

/* Outcome logging: the ONLY path to a future trained model. */
async function outcome(ctx) {
  const b = await http.readBody(ctx.req);
  const errs = http.validate(b, {
    counterpart_id: { type: 'string', required: true },
    stage: { type: 'string', required: true, enum: ['profile_view', 'mutual_interest', 'message_started', 'conversation_depth', 'meetup', 'match', 'move_in', 'lease_completion', 'satisfaction', 'conflict', 'early_termination'] }
  });
  if (errs) return http.badRequest(ctx.res, 'Invalid outcome.', errs);
  const row = {
    outcome_id: 'ro' + Date.now(),
    user_id: ctx.analyticsId, counterpart_id: b.counterpart_id,
    stage: b.stage, value: b.value === undefined ? null : b.value,
    /* profiles snapshotted AT MATCH TIME so the eventual model has
       leakage-free features */
    profile_snapshot: store.db.profiles[ctx.user.email] || null,
    timestamp: Date.now()
  };
  store.db.roommate_outcomes.push(row);
  store.save();
  events.emit(b.stage, { user_id: ctx.analyticsId, surface: 'roommates', metadata: { counterpart: b.counterpart_id, value: row.value } }, { userId: ctx.analyticsId });
  return http.created(ctx.res, { recorded: row.outcome_id });
}

async function outcomeStats(ctx) {
  const rows = store.db.roommate_outcomes || [];
  const by = {};
  rows.forEach((r) => { by[r.stage] = (by[r.stage] || 0) + 1; });
  const MIN_OUTCOMES = 500;
  const trainable = (by.move_in || 0);
  return http.ok(ctx.res, {
    total_outcomes: rows.length,
    by_stage: by,
    labeled_cohabitations: trainable,
    minimum_for_training: MIN_OUTCOMES,
    ready_to_train: trainable >= MIN_OUTCOMES,
    active_model: null,
    note: 'Roommate ranking is heuristic. A pairwise model requires ' + MIN_OUTCOMES +
      ' cohabitation outcomes; bridge labels (mutual_interest, conversation_depth) accumulate meanwhile.'
  });
}

module.exports = {
  compatibility, CRITERIA,
  routes: [
    { method: 'GET', path: '/api/roommates', handler: list },
    { method: 'POST', path: '/api/roommates/outcomes', handler: outcome, opts: { auth: true } },
    { method: 'GET', path: '/api/roommates/outcomes/stats', handler: outcomeStats }
  ]
};
