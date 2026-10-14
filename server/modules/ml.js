/* Model registry + experiment administration API. */
const http = require('../lib/http');
const store = require('../lib/store');
const registry = require('../ml/registry');
const inference = require('../ml/inference');
const experiments = require('../experiments/experiments');
const cfg = require('../lib/config');

async function models(ctx) {
  const rows = registry.list(ctx.url.searchParams.get('use_case'));
  return http.ok(ctx.res, {
    models: rows.map((m) => Object.assign({}, m, { gate_check: registry.checkGates(m) })),
    active: registry.active('recommendations'),
    shadow: registry.shadow('recommendations'),
    mode: registry.mode(),
    gates: cfg.GATES
  });
}

async function promote(ctx) {
  const b = await http.readBody(ctx.req);
  const errs = http.validate(b, {
    model_id: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: registry.STATUSES }
  });
  if (errs) return http.badRequest(ctx.res, 'Invalid promotion request.', errs);
  const result = registry.setStatus(b.model_id, b.status);
  if (!result.ok) return http.badRequest(ctx.res, result.error, result.reasons);
  return http.ok(ctx.res, { model: result.model, mode: registry.mode() });
}

async function mlStatus(ctx) {
  return http.ok(ctx.res, inference.status());
}

async function listExperiments(ctx) {
  return http.ok(ctx.res, { experiments: store.db.experiments || [], running: experiments.running() });
}

async function createExperiment(ctx) {
  const b = await http.readBody(ctx.req);
  const errs = http.validate(b, { name: { type: 'string', required: true, max: 120 } });
  if (errs) return http.badRequest(ctx.res, 'Invalid experiment.', errs);
  return http.created(ctx.res, { experiment: experiments.create(b) });
}

async function stopExperiment(ctx) {
  const e = experiments.stop(ctx.params[0]);
  if (!e) return http.notFound(ctx.res, 'Experiment not found.');
  return http.ok(ctx.res, { experiment: e });
}

module.exports = {
  routes: [
    { method: 'GET', path: '/api/ml/models', handler: models },
    { method: 'POST', path: '/api/ml/models/promote', handler: promote, opts: { admin: true } },
    { method: 'GET', path: '/api/ml/status', handler: mlStatus },
    { method: 'GET', path: '/api/ml/experiments', handler: listExperiments, opts: { admin: true } },
    { method: 'POST', path: '/api/ml/experiments', handler: createExperiment, opts: { admin: true } },
    { method: 'POST', path: /^\/api\/ml\/experiments\/([\w-]+)\/stop$/, handler: stopExperiment, opts: { admin: true } }
  ]
};
