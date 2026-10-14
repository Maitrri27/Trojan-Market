/* ML inference client.

   Talks to the Python scoring service (ml/serve/inference_api.py) over HTTP
   with a hard timeout. Any failure — unreachable, slow, malformed, model
   inactive — returns null, and the caller falls back to heuristic ranking.
   The marketplace must never break because ML is down.
*/
const cfg = require('../lib/config');
const log = require('../lib/log');
const registry = require('./registry');

let breaker = { failures: 0, openUntil: 0 };
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30000;

function available() {
  if (!cfg.ML_ENABLED) return { ok: false, reason: 'ML_ENABLED=false' };
  if (!cfg.ML_INFERENCE_URL) return { ok: false, reason: 'no TM_ML_URL configured' };
  if (Date.now() < breaker.openUntil) return { ok: false, reason: 'circuit breaker open' };
  const model = registry.active('recommendations') || registry.shadow('recommendations');
  if (!model) return { ok: false, reason: 'no active or shadow model in registry' };
  const gate = registry.checkGates(model);
  if (!gate.passed && model.status === 'active') return { ok: false, reason: 'gates failed: ' + gate.reasons.join('; ') };
  return { ok: true, model: model };
}

/**
 * Score a candidate set. Never throws.
 * @returns {Promise<{scores: Object, model_version: string, latency_ms: number}|null>}
 */
async function score(rows, context) {
  const av = available();
  if (!av.ok) return null;

  const done = log.timer('ml.inference');
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), cfg.ML_INFERENCE_TIMEOUT_MS);

  try {
    const resp = await fetch(cfg.ML_INFERENCE_URL.replace(/\/$/, '') + '/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_version: av.model.version,
        feature_version: av.model.feature_version,
        context: context || {},
        rows: rows
      }),
      signal: ctl.signal
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error('inference HTTP ' + resp.status);
    const data = await resp.json();
    if (!data || typeof data.scores !== 'object') throw new Error('malformed inference response');
    breaker.failures = 0;
    const ms = done();
    log.bump('ml.inference.ok');
    return { scores: data.scores, model_version: data.model_version || av.model.version, latency_ms: ms };
  } catch (e) {
    clearTimeout(timeout);
    done();
    breaker.failures++;
    log.bump('ml.inference.failed');
    if (breaker.failures >= BREAKER_THRESHOLD) {
      breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      breaker.failures = 0;
      log.warn('ml', 'circuit breaker opened — falling back to heuristic', { cooldown_ms: BREAKER_COOLDOWN_MS });
    }
    return null;
  }
}

function status() {
  const av = available();
  return {
    enabled: cfg.ML_ENABLED,
    url_configured: !!cfg.ML_INFERENCE_URL,
    reachable_check: av.ok,
    reason: av.reason || null,
    model_weight: cfg.ML_MODEL_WEIGHT,
    breaker_open: Date.now() < breaker.openUntil,
    active_model: registry.active('recommendations'),
    shadow_model: registry.shadow('recommendations')
  };
}

module.exports = { available, score, status };
