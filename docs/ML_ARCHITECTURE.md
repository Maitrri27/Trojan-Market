# ML Architecture

## The governing principle

The complete pipeline exists. **No model serves traffic until real behavioural
data clears explicit, machine-checked gates.** There is no synthetic training
data anywhere in this repository, no hard-coded prediction, and no "AI score"
shown to users that isn't computed by a real evaluated model.

At launch the system runs on a transparent heuristic ranker, and it says so —
`GET /api/recommendations/status` returns `mode: "heuristic"`, and the admin
dashboard prints it in a banner.

## Flow

```
                     user action
                          |
                    Event Logging  (POST /api/events)
                          |
             Raw Event Store  events.jsonl  APPEND-ONLY
                          |
        +-----------------+------------------+
        |                                    |
  Online features                  Offline dataset builder
  (preferences.js)                 (build_recommendation_dataset.py)
        |                                    |
  Candidate generation               Feature engineering
        |                            (recommendation_features.py)
  Heuristic ranker                           |
        |                            LightGBM LambdaRank
        |                            (train_ranker.py)
        |                                    |
        |                              Evaluation
        |                            (evaluate_ranker.py)
        |                                    |
        |                            Confidence gates
        |                                    |
        |                            Model registry
        |                            candidate -> shadow -> active
        |                                    |
        |                            Inference API :8500
        |                                    |
        +----------> ranker.js blend <-------+
                          |
                    Ranked feed  +  impression logging
```

## The two data stores, and why they are separate

| | `db.json` | `events.jsonl` |
|---|---|---|
| Contents | users, listings, threads, profiles | behavioural observations |
| Mutability | mutable | **append-only, never rewritten** |
| On logic change | updated in place | untouched; datasets are rebuilt |
| Contains identity | yes (emails) | no — pseudonymous `u_<hash>` only |

Changing how relevance is graded does not rewrite history. `ml/config.yaml`
holds the label map; edit it and rebuild the dataset. The raw record of what
happened stays exactly as observed.

## Impression logging

Every listing **shown** is logged, not just the ones clicked. Both server and
client do this:

* `recommendations/ranker.js` logs one impression per returned item, with
  `rank_position`, `surface`, `recommendation_source`, `model_version`,
  `experiment_id`, `variant` and `propensity`.
* The frontend logs impressions per rendered surface (home, foryou, search,
  housing) with rank and viewport visibility, batched every 4 seconds and
  flushed on tab hide.

Without negatives there is no learning-to-rank dataset. This is the single most
important instrumentation decision in the project.

## Labels

Graded relevance, defined in `ml/config.yaml` and applied in
`ml/data/labels.py`:

| label | meaning | source events |
|---|---|---|
| 0 | shown, ignored | impression only |
| 1 | examined | click, detail_view, dwell_30s |
| 2 | kept | save, share |
| 3 | contacted | message_sent, reply_received, offer_sent |
| 4 | transacted | offer_accepted, meetup_agreed, transaction_confirmed, marked_sold/rented |

The strongest signal wins — engagement is monotonic, not additive.

### Visibility-aware negatives

Treating every un-clicked impression as a confident negative is the classic way
to poison a ranker. Instead:

| situation | sample weight |
|---|---|
| above-fold impression (rank < 6), no engagement | 1.00 |
| below-fold, but the user engaged with something ranked lower | 1.00 |
| below-fold, never demonstrably seen | 0.25 |
| explicit "not for me" skip | 1.50 |
| any positive | 1.00 |
| served under exploration | divided by propensity (IPW) |

## Leakage prevention

Four mechanisms, all enforced in code:

1. **Chronological replay.** `RunningState` accumulates popularity, affinity
   and price statistics as events are processed in timestamp order. Each
   impression is featurised from state *before* it, then the state is updated.
2. **Time-based split.** train / valid / test are contiguous time slices, never
   random. The builder asserts `min(test_ts) >= max(train_ts)` and raises if
   violated. Ranking groups are never split across a boundary.
3. **Forbidden feature list.** `FORBIDDEN_FEATURES` in
   `recommendation_features.py` names every protected attribute and every
   future-derived column. `assert_no_forbidden()` runs before training and
   throws if any appears.
4. **Attribution window.** An engagement only labels an impression if it
   happened after it, in the same session, within `attribution_window_s`.

## Position bias

`rank_position` is recorded on every impression but **excluded from the model's
input matrix** (`BIAS_ONLY_FEATURES`). A model that learns "rank 1 is relevant"
just reproduces the ranker that generated its training data.

Correction is available through controlled exploration: with `TM_EXPLORE=true`,
5% of traffic gets two adjacent top-5 results swapped, and the swap records
`original_rank`, `served_rank` and `propensity`. The dataset builder applies
inverse-propensity weighting to those rows.

## Confidence gates

Defined once, checked in three places (`server/lib/config.js`,
`ml/config.yaml`, `ml/common.py:check_gates`):

| gate | default |
|---|---|
| training examples | 50,000 |
| unique users | 300 |
| unique sessions | 2,000 |
| positive events | 2,000 |
| test NDCG@10 | 0.30 |
| improvement over heuristic baseline | +0.02 |

A model failing any gate is registered as `rejected`. `registry.setStatus(id,
'active')` re-checks the gates, so a model cannot be activated by hand-editing
a status field.

## Blending

```js
if (ml_available && model.status === 'active') {
  final = (1 - w) * heuristic_norm + w * ml_norm;   // w = TM_ML_WEIGHT
} else {
  final = heuristic;                                 // always the fallback
}
```

`TM_ML_WEIGHT=0` is the default and means pure heuristic. Ramp it deliberately:
0 → 0.2 → 0.5 → 1.0, watching save and message rate at each step.

## Failure behaviour

The marketplace never depends on ML being up:

* inference timeout (120 ms default) → heuristic
* HTTP error, malformed response → heuristic
* feature-version mismatch → 409, heuristic
* 5 consecutive failures → circuit breaker opens for 30 s → heuristic
* model missing from registry → heuristic
* gates not satisfied → heuristic

## What is deliberately NOT a model

| area | today | why |
|---|---|---|
| Roommate matching | transparent heuristic | needs ~500 cohabitation outcomes; that is 2-4 semesters. Bridge labels accumulate now. |
| House Match | transparent heuristic | Bradley-Terry weights need ~5,000 pairwise preferences; collection endpoint is live. |
| Fraud detection | rules + human review | needs ~1,000 moderator decisions. A classifier trained on a handful would just relearn the rules. |
| Semantic search | keyword + filters | no vector database until keyword search demonstrably fails. |

Each has a live counter (`/api/roommates/outcomes/stats`,
`/api/housing/pairwise/stats`, `/api/moderation/fraud/stats`) reporting
`ready_to_train: false` and `active_model: null` until the data exists.
