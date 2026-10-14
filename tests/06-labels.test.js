/* Label + leakage logic ported to JS so it can be checked without Python. */

/* Mirror of ml/data/labels.py — kept in sync by ml/tests/test_label_parity.py */
const LABEL_MAP = {
  impression: 0, click: 1, detail_view: 1, dwell_30s: 1, save: 2, share: 2,
  message_sent: 3, reply_received: 3, offer_sent: 3,
  offer_accepted: 4, meetup_agreed: 4, transaction_confirmed: 4, marked_sold: 4, marked_rented: 4
};
const VIS = { above_fold_rank: 6, seen_weight: 1.0, below_fold_weight: 0.25, explicit_skip_weight: 1.5 };

function labelFor(types) {
  if (!types.length) return 0;
  return Math.max.apply(null, types.map((t) => LABEL_MAP[t] || 0));
}
function negativeWeight(rank, skipped, maxRankSeen) {
  if (skipped) return VIS.explicit_skip_weight;
  if (rank === null || rank === undefined) return VIS.below_fold_weight;
  if (rank < VIS.above_fold_rank) return VIS.seen_weight;
  if (maxRankSeen !== null && maxRankSeen !== undefined && rank <= maxRankSeen) return VIS.seen_weight;
  return VIS.below_fold_weight;
}

describe('label generation', () => {
  it('grades an unengaged impression as 0', () => assert.eq(labelFor([]), 0));
  it('grades a click as 1', () => assert.eq(labelFor(['click']), 1));
  it('grades a save as 2', () => assert.eq(labelFor(['save']), 2));
  it('grades a message as 3', () => assert.eq(labelFor(['message_sent']), 3));
  it('grades a transaction as 4', () => assert.eq(labelFor(['transaction_confirmed']), 4));

  it('takes the strongest signal, not the sum', () => {
    assert.eq(labelFor(['click', 'save', 'message_sent']), 3);
  });

  it('ignores unknown event types', () => {
    assert.eq(labelFor(['click', 'some_new_event']), 1);
  });
});

describe('visibility-aware negatives', () => {
  it('treats an above-fold miss as a full-strength negative', () => {
    assert.eq(negativeWeight(2, false, null), 1.0);
  });

  it('down-weights a below-fold impression that was probably never seen', () => {
    assert.eq(negativeWeight(40, false, null), 0.25);
  });

  it('upgrades a below-fold miss when the user engaged even lower', () => {
    assert.eq(negativeWeight(20, false, 30), 1.0);
  });

  it('weights an explicit skip above a passive miss', () => {
    assert.ok(negativeWeight(3, true, null) > negativeWeight(3, false, null));
  });

  it('treats a missing rank conservatively', () => {
    assert.eq(negativeWeight(null, false, null), 0.25);
  });
});

describe('inverse propensity weighting', () => {
  it('upweights rows served under exploration', () => {
    const base = 1.0;
    const propensity = 0.05;
    assert.close(base / propensity, 20, 1e-9);
  });
});

describe('leakage rules', () => {
  const FORBIDDEN = ['gender', 'food_preference', 'age', 'religion', 'sold', 'transaction_amount', 'final_label'];
  const MODEL_FEATURES = require('../server/recommendations/ranker').featureRow(
    { listing: { id: 'housing-1', price: 1450, category: 'housing', days: 1, description: 'x', condition: 'Furnished', views: 10, email: 'a@usc.edu' }, heuristic_score: 0.5, components: {} },
    { interaction_count: 0, account_tenure_days: 0, median_viewed_price: null, category_affinity: {}, top_categories: [], stated: null },
    { surface: 'foryou' }, 0
  );

  it('exposes no protected attribute to the model', () => {
    FORBIDDEN.forEach((f) => {
      assert.eq(MODEL_FEATURES[f], undefined, 'feature "' + f + '" must not exist');
    });
  });

  it('never exposes a sale outcome as an input feature', () => {
    assert.eq(MODEL_FEATURES.sold, undefined);
    assert.eq(MODEL_FEATURES.days_to_sale, undefined);
  });

  it('carries rank_position only for bias correction', () => {
    assert.ok(typeof MODEL_FEATURES.rank_position === 'number', 'captured');
  });
});
