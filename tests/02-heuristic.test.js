/* Heuristic ranker: works with no data, responds to preferences, deterministic. */
const heuristic = require('../server/recommendations/heuristic_ranker');
const { SEED } = require('../server/data');

const EMPTY_PREFS = {
  has_history: false, interaction_count: 0, account_tenure_days: 0,
  category_affinity: {}, top_categories: [], top_neighborhoods: [],
  median_viewed_price: null, median_saved_price: null, skips: [], stated: null
};

describe('heuristic ranker', () => {
  it('ranks with zero user data (cold start)', () => {
    const out = heuristic.rank(SEED.slice(0, 20), EMPTY_PREFS, {});
    assert.eq(out.length, 20);
    assert.ok(out[0].heuristic_score > 0, 'produces a real score');
  });

  it('returns results in descending score order', () => {
    const out = heuristic.rank(SEED.slice(0, 30), EMPTY_PREFS, {});
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].heuristic_score >= out[i].heuristic_score, 'sorted at index ' + i);
    }
  });

  it('is deterministic for identical inputs', () => {
    const a = heuristic.rank(SEED.slice(0, 15), EMPTY_PREFS, {});
    const b = heuristic.rank(SEED.slice(0, 15), EMPTY_PREFS, {});
    assert.eq(a.map((x) => x.listing.id), b.map((x) => x.listing.id));
  });

  it('lifts listings in the user\'s affine category', () => {
    const prefs = Object.assign({}, EMPTY_PREFS, {
      has_history: true, category_affinity: { electronics: 0.9 }, top_categories: ['electronics']
    });
    const out = heuristic.rank(SEED, prefs, {});
    const topTen = out.slice(0, 10).filter((x) => x.listing.category === 'electronics').length;
    assert.ok(topTen >= 3, 'expected electronics to surface, got ' + topTen);
  });

  it('respects a stated housing budget', () => {
    const prefs = Object.assign({}, EMPTY_PREFS, {
      stated: { budgetMin: 800, budgetMax: 1100, hood: 'USC Village', commuteMax: 10, pets: false, furnished: true, lease: 12, beds: 1 }
    });
    const housing = SEED.filter((l) => l.category === 'housing');
    const out = heuristic.rank(housing, prefs, {});
    const top = out[0].components.price_relevance;
    const worst = out[out.length - 1].components.price_relevance;
    assert.ok(top >= worst, 'in-budget homes score at least as well on price');
  });

  it('emits every weighted component', () => {
    const out = heuristic.rank([SEED[0]], EMPTY_PREFS, {});
    Object.keys(heuristic.WEIGHTS).forEach((k) => {
      assert.ok(typeof out[0].components[k] === 'number', 'component ' + k + ' present');
    });
  });

  it('keeps all component scores inside [0,1]', () => {
    heuristic.rank(SEED, EMPTY_PREFS, {}).forEach((e) => {
      Object.keys(e.components).forEach((k) => {
        assert.ok(e.components[k] >= 0 && e.components[k] <= 1, k + ' out of range: ' + e.components[k]);
      });
    });
  });

  it('weights sum to 1', () => {
    const total = Object.values(heuristic.WEIGHTS).reduce((a, b) => a + b, 0);
    assert.close(total, 1, 1e-9);
  });
});
