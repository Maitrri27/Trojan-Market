/* Experiment assignment + controlled exploration.

   Assignment is deterministic (hash of experiment + user) so a user sees a
   stable variant across sessions without storing per-user rows.
*/
const crypto = require('crypto');
const cfg = require('../lib/config');
const store = require('../lib/store');

function hashUnit(experimentId, unitId) {
  const h = crypto.createHash('sha256').update(experimentId + '|' + (unitId || 'anon')).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function running(now) {
  const t = now || Date.now();
  return (store.db.experiments || []).filter((e) =>
    e.status === 'running' &&
    (!e.start_time || e.start_time <= t) &&
    (!e.end_time || e.end_time >= t));
}

/** @returns {{experiment_id, variant}|null} */
function assign(unitId, surface) {
  const active = running().filter((e) => !e.surface || e.surface === surface);
  if (!active.length) return null;
  const exp = active[0];
  const u = hashUnit(exp.experiment_id, unitId);
  const split = exp.traffic_split === undefined ? 0.5 : exp.traffic_split;
  return { experiment_id: exp.experiment_id, variant: u < split ? exp.control_variant : exp.treatment_variant };
}

function create(def) {
  const exp = {
    experiment_id: def.experiment_id || 'exp_' + crypto.randomBytes(4).toString('hex'),
    name: def.name || 'unnamed',
    description: def.description || '',
    surface: def.surface || null,
    control_variant: def.control_variant || 'heuristic',
    treatment_variant: def.treatment_variant || 'ml_blend',
    traffic_split: def.traffic_split === undefined ? 0.5 : def.traffic_split,
    primary_metric: def.primary_metric || 'save_rate',
    guardrail_metrics: def.guardrail_metrics || ['message_rate', 'transaction_rate'],
    start_time: def.start_time || Date.now(),
    end_time: def.end_time || null,
    status: def.status || 'running',
    created_at: Date.now()
  };
  store.db.experiments.push(exp);
  store.save();
  return exp;
}

function stop(experimentId) {
  const e = (store.db.experiments || []).filter((x) => x.experiment_id === experimentId)[0];
  if (!e) return null;
  e.status = 'stopped'; e.end_time = Date.now();
  store.save();
  return e;
}

/* --------------------------------------------------- controlled exploration

   To de-bias click data we occasionally swap two adjacent top-N results for a
   small traffic slice, and record the propensity so the training pipeline can
   apply inverse-propensity weighting. Deliberately tiny and bounded.
*/
function explore(ranked, unitId) {
  if (!cfg.EXPLORATION_ENABLED) return { rows: ranked, explored: false, propensity: 1 };
  const u = hashUnit('exploration', unitId + '|' + Math.floor(Date.now() / 3600000));
  if (u > cfg.EXPLORATION_TRAFFIC) return { rows: ranked, explored: false, propensity: 1 };

  const depth = Math.min(cfg.EXPLORATION_SWAP_DEPTH, ranked.length);
  if (depth < 2) return { rows: ranked, explored: false, propensity: 1 };
  const i = Math.floor((u / cfg.EXPLORATION_TRAFFIC) * (depth - 1));
  const rows = ranked.slice();
  const tmp = rows[i]; rows[i] = rows[i + 1]; rows[i + 1] = tmp;
  return { rows: rows, explored: true, swapped: [i, i + 1], propensity: cfg.EXPLORATION_TRAFFIC };
}

module.exports = { assign, create, stop, running, explore, hashUnit };
