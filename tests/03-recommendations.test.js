/* Recommendation service: cold start, fallback, ML unavailable, impressions. */
const ranker = require('../server/recommendations/ranker');
const registry = require('../server/ml/registry');
const inference = require('../server/ml/inference');
const store = require('../server/lib/store');

describe('recommendation service', () => {
  it('serves a cold-start user without ML', async () => {
    const out = await ranker.rank({ surface: 'foryou', limit: 5, analyticsId: null, logImpressions: false });
    assert.eq(out.recommendations.length, 5);
    assert.eq(out.meta.mode, 'heuristic');
    assert.eq(out.meta.cold_start, true);
    assert.eq(out.meta.source, 'heuristic');
  });

  it('reports why ML is unavailable rather than failing', async () => {
    const out = await ranker.rank({ surface: 'foryou', limit: 3, logImpressions: false });
    assert.ok(out.meta.ml_unavailable_reason, 'reason is surfaced');
    assert.eq(out.meta.model_version, null);
  });

  it('never returns an empty feed', async () => {
    const out = await ranker.rank({ surface: 'foryou', limit: 20, logImpressions: false });
    assert.ok(out.recommendations.length > 0, 'cold-start feed is populated');
  });

  it('logs one impression per listing shown', async () => {
    const before = store.eventTotal();
    const out = await ranker.rank({ surface: 'foryou', limit: 6, analyticsId: 'u_imp_test', sessionId: 's1' });
    const after = store.eventTotal();
    assert.eq(after - before, out.recommendations.length, 'impression per shown listing');
  });

  it('records rank_position on every impression', async () => {
    await ranker.rank({ surface: 'foryou', limit: 4, analyticsId: 'u_rank_test', sessionId: 's_rank' });
    const rows = store.readEvents({ user_id: 'u_rank_test', event_type: 'impression' });
    assert.ok(rows.length >= 4);
    rows.slice(0, 4).forEach((r) => assert.ok(typeof r.rank_position === 'number', 'rank recorded'));
  });

  it('attaches an explanation to each recommendation', async () => {
    const out = await ranker.rank({ surface: 'foryou', limit: 3, logImpressions: false });
    out.recommendations.forEach((r) => assert.ok(Array.isArray(r.explanation) && r.explanation.length));
  });

  it('honours the requested limit', async () => {
    const out = await ranker.rank({ surface: 'foryou', limit: 2, logImpressions: false });
    assert.eq(out.recommendations.length, 2);
  });

  it('excludes skipped listings from candidates', async () => {
    const first = await ranker.rank({ surface: 'foryou', limit: 5, logImpressions: false });
    const skipId = first.recommendations[0].listing_id;
    const out = await ranker.rank({ surface: 'foryou', limit: 20, excludeIds: [skipId], logImpressions: false });
    assert.eq(out.recommendations.filter((r) => r.listing_id === skipId).length, 0);
  });

  it('reports candidate source mix', async () => {
    const out = await ranker.rank({ surface: 'foryou', limit: 5, logImpressions: false });
    assert.ok(out.meta.candidate_count > 0);
    assert.ok(out.meta.candidate_sources && typeof out.meta.candidate_sources === 'object');
  });
});

describe('ml gating', () => {
  it('starts in heuristic mode with no registered model', () => {
    assert.eq(registry.mode(), 'heuristic');
  });

  it('reports ML as unavailable when disabled', () => {
    const s = inference.status();
    assert.eq(s.reachable_check, false);
    assert.ok(s.reason);
  });

  it('fails an empty model against the gates', () => {
    const g = registry.checkGates(null);
    assert.eq(g.passed, false);
  });

  it('fails a model with insufficient data', () => {
    const g = registry.checkGates({
      dataset_stats: { n_examples: 100, n_users: 2, n_sessions: 5, n_positives: 3 },
      metrics: { 'ndcg@10': 0.9, ndcg_lift_over_baseline: 0.5 }
    });
    assert.eq(g.passed, false);
    assert.ok(g.reasons.length >= 4, 'reports each shortfall');
  });

  it('fails a model that does not beat the baseline', () => {
    const g = registry.checkGates({
      dataset_stats: { n_examples: 1e6, n_users: 5000, n_sessions: 50000, n_positives: 90000 },
      metrics: { 'ndcg@10': 0.55, ndcg_lift_over_baseline: 0.001 }
    });
    assert.eq(g.passed, false);
    assert.ok(g.reasons.some((r) => r.indexOf('improvement_over_baseline') >= 0));
  });

  it('passes a model meeting every gate', () => {
    const g = registry.checkGates({
      dataset_stats: { n_examples: 1e6, n_users: 5000, n_sessions: 50000, n_positives: 90000 },
      metrics: { 'ndcg@10': 0.62, ndcg_lift_over_baseline: 0.08 }
    });
    assert.eq(g.passed, true);
  });

  it('refuses inference when no model is registered', async () => {
    const out = await inference.score([{ listing_id: 'x' }], {});
    assert.eq(out, null, 'returns null so the caller falls back');
  });
});
