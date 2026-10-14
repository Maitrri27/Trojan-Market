/* Model registry — the source of truth for which model, if any, is live.

   Statuses: candidate -> shadow -> active -> archived, or rejected.
   Only ONE model may be 'active' per use case. Written by the Python trainer
   (ml/registry/registry.py) and read here; both use the same JSON file.
*/
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config');
const log = require('../lib/log');

const STATUSES = ['candidate', 'shadow', 'active', 'archived', 'rejected'];

function emptyRegistry() {
  return { registry_version: 1, models: [], updated_at: null };
}

function read() {
  try { return JSON.parse(fs.readFileSync(cfg.REGISTRY_FILE, 'utf8')); }
  catch (e) { return emptyRegistry(); }
}

function write(reg) {
  reg.updated_at = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(cfg.REGISTRY_FILE), { recursive: true });
    fs.writeFileSync(cfg.REGISTRY_FILE, JSON.stringify(reg, null, 2));
    return true;
  } catch (e) { log.error('registry', 'write failed', e); return false; }
}

function list(useCase) {
  const models = read().models || [];
  return useCase ? models.filter((m) => m.use_case === useCase) : models;
}

function byStatus(status, useCase) {
  return list(useCase).filter((m) => m.status === status)
    .sort((a, b) => String(b.training_timestamp).localeCompare(String(a.training_timestamp)));
}

function active(useCase) { return byStatus('active', useCase || 'recommendations')[0] || null; }
function shadow(useCase) { return byStatus('shadow', useCase || 'recommendations')[0] || null; }

/** Evaluate a model record against the configured confidence gates. */
function checkGates(model) {
  if (!model) return { passed: false, reasons: ['no model registered'] };
  const g = cfg.GATES;
  const m = model.metrics || {};
  const d = model.dataset_stats || {};
  const reasons = [];
  const check = (name, actual, required, cmp) => {
    if (actual === undefined || actual === null) { reasons.push(name + ': not reported'); return; }
    const pass = cmp === 'gte' ? actual >= required : actual > required;
    if (!pass) reasons.push(name + ': ' + actual + ' < required ' + required);
  };
  check('training_examples', d.n_examples, g.minimum_training_examples, 'gte');
  check('unique_users', d.n_users, g.minimum_unique_users, 'gte');
  check('unique_sessions', d.n_sessions, g.minimum_unique_sessions, 'gte');
  check('positive_events', d.n_positives, g.minimum_positive_events, 'gte');
  check('test_ndcg@10', m['ndcg@10'], g.minimum_test_score, 'gte');
  const lift = m.ndcg_lift_over_baseline;
  check('improvement_over_baseline', lift, g.minimum_improvement_over_baseline, 'gte');
  return { passed: reasons.length === 0, reasons: reasons, gates: g };
}

function setStatus(modelId, status) {
  if (STATUSES.indexOf(status) < 0) throw new Error('Unknown status: ' + status);
  const reg = read();
  const target = (reg.models || []).filter((m) => m.model_id === modelId)[0];
  if (!target) return { ok: false, error: 'model not found: ' + modelId };
  if (status === 'active') {
    const gate = checkGates(target);
    if (!gate.passed) return { ok: false, error: 'confidence gates not satisfied', reasons: gate.reasons };
    reg.models.forEach((m) => { if (m.use_case === target.use_case && m.status === 'active') m.status = 'archived'; });
  }
  target.status = status;
  target.status_changed_at = new Date().toISOString();
  write(reg);
  log.info('registry', 'status changed', { model: modelId, status: status });
  return { ok: true, model: target };
}

/** Overall mode the recommendation service is operating in. */
function mode() {
  const a = active('recommendations');
  const s = shadow('recommendations');
  if (a && cfg.ML_ENABLED && cfg.ML_MODEL_WEIGHT > 0) return 'ml_active';
  if (s) return 'shadow_ml';
  return 'heuristic';
}

module.exports = { STATUSES, read, write, list, byStatus, active, shadow, checkGates, setStatus, mode, emptyRegistry };
