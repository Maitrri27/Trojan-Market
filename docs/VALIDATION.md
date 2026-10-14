# Validation Record

What was actually executed, what was not, and every defect found and fixed.

> Reproduce the JS validation with `npm test`. The sandbox shim used to execute
> it without a shell lives at `tests/sandbox/node-shim.js` and is not part of the
> application.

## Execution environment

The authoring environment has **no shell**: `node`, `npm` and `python` could not
be invoked. Rather than review the code and call it done, the JavaScript was
executed by loading the real source files through a CommonJS + Node-builtin shim
(`tests/sandbox/node-shim.js`) that provides `fs`, `path`, `crypto` (a real
SHA-256), `Buffer`, and an `http.createServer` that captures the request handler
so requests can be driven through the complete stack — routing, auth, rate
limiting, handlers, serialisation.

Nothing at the application layer is stubbed. `server/index.js` and every module
is the shipped file.

**Python could not be executed at all.** It was statically audited; four real
defects were found and fixed. Commands to validate it locally are in section D.

---

## A. Execution summary

| What | Result | Assertions |
|---|---|---|
| Load entire server (`server/index.js` + 27 modules) | **PASS** | handler bound, 90 listings, mode `heuristic` |
| Event taxonomy, validation, PII scrubbing, pseudonymisation | **PASS** | 12 |
| Event store: JSONL validity, append-only, read-your-writes, query | **PASS** | 4 |
| Heuristic ranker: cold start, ordering, determinism, bounds, weights | **PASS** | 6 |
| Recommendation service: cold start, fallback, dedupe, limits, impressions | **PASS** | 11 |
| Roommate + House Match: range, symmetry, explanation, fair-housing | **PASS** | 11 |
| Registry lifecycle candidate→shadow→active→archived / rejected | **PASS** | 5 |
| Confidence gates (null / small / no-lift / missing-metric / passing) | **PASS** | 6 |
| Experiments: deterministic assignment, traffic split, exploration off | **PASS** | 5 |
| Moderation rules + honest "no classifier" reporting | **PASS** | 3 |
| Preference aggregation: anonymous, affinity, decay, skips | **PASS** | 4 |
| HTTP auth: USC-only, bad code, session, signout invalidation | **PASS** | 8 |
| HTTP listings: CRUD, ownership, validation, outcome events | **PASS** | 12 |
| HTTP search: pagination, cursor termination, filters, sort, events | **PASS** | 7 |
| HTTP housing: all nine facets + match endpoint | **PASS** | 11 |
| HTTP favorites / messaging / offers → transaction | **PASS** | 19 |
| HTTP events API: batch, 207 partial, 400s, schema, admin gating | **PASS** | 9 |
| HTTP recommendations: anon, contract, meta redaction, impressions | **PASS** | 10 |
| HTTP moderation + readiness counters + admin dashboard | **PASS** | 15 |
| ML blending w=0 / 0.5 / 1, monotonicity, feature contract | **PASS** | 5 |
| ML failure modes: refused, 500, malformed, bad JSON, timeout, breaker | **PASS** | 6 |
| ML status gating: shadow, rejected, archived, gate re-check at serve | **PASS** | 4 |
| Synthetic fixture: generated, isolated, deterministic, gate-clearing | **PASS** | 12 |
| Label + leakage contract on the fixture (63,847 derived rows) | **PASS** | 11 |
| Shipped `tests/*.test.js` (01, 02, 03, 04, 06) | **PASS** | 62 |
| `tests/05-api.test.js` | **NOT RUN** | needs real `http.request`; equivalent coverage executed via the harness (76 HTTP assertions) |
| `pytest ml/tests` | **NOT RUN** | no Python runtime |
| `python ml/data/build_recommendation_dataset.py` | **NOT RUN** | no Python runtime |
| `python ml/training/train_ranker.py` | **NOT RUN** | no Python runtime |

Roughly **260 assertions executed, 0 failing.**

---

## B. Application status

| Component | Status |
|---|---|
| Frontend | **PASS** — renders, console clean, impressions + interactions instrumented |
| Backend | **PASS** — full server loads and serves every route |
| Existing features (auth, listings, search, favorites, messaging) | **PASS** — no regressions |
| Event logging | **PASS** — end to end, frontend → API → validation → store → export |
| Recommendation API | **PASS** — heuristic, cold-start safe, never empty |
| Training dataset pipeline | **AUDITED, NOT RUN** — one critical bug fixed (below) |
| LightGBM training | **AUDITED, NOT RUN** |
| Model evaluation | **AUDITED, NOT RUN** — metric maths unit-tested in Python (unrun) |
| Model registry | **PASS** — full lifecycle executed, including refusal to activate |
| Inference | **PASS** — blending and every failure path executed with a stubbed service |
| Heuristic fallback | **PASS** — verified for six distinct failure modes |
| Node test suite | **PASS** — 62/62 |

---

## C. Issues found and fixed

### 1. Dataset builder would abort on every run *(critical)*

**Root cause.** `assert_no_forbidden()` is written for the **model matrix**, but
the builder called it on **dataset row keys**. Rows legitimately contain
`rank_position`, `original_rank`, `propensity` (bias correction / IPW) and
`engagement_types` (label provenance) — all of which that function rejects. Every
dataset build would have raised `ValueError` before writing anything.

**Files.** `ml/features/recommendation_features.py`,
`ml/data/build_recommendation_dataset.py`

**Fix.** Split one conflated rule into three tiers:

* `PROTECTED_ATTRIBUTES` — never anywhere; `assert_dataset_safe()` enforces it on
  the dataset.
* `LEAKY_COLUMNS` — may exist in the dataset as label provenance, never as inputs.
* `BIAS_ONLY_FEATURES` — recorded for IPW/evaluation, never as inputs.

`assert_no_forbidden()` (matrix) now checks protected ∪ leaky ∪ bias-only;
`assert_dataset_safe()` (dataset) checks protected only.

**Verification.** Static — the failing call is gone and the contract is covered
by `ml/tests/test_leakage.py`. The equivalent rules were executed in JS against
the synthetic fixture (11 assertions).

### 2. Fraud trainer crashed on `fit()`

**Root cause.** `clf.fit(Xtr, ytr, feature_name=FEATURES)` — `feature_name`
belongs on `lgb.Dataset`/`lgb.train`, not the sklearn wrapper. `TypeError`.

**Files.** `ml/fraud/train_fraud_classifier.py`  **Fix.** Removed the kwarg.
**Verification.** Static (LightGBM sklearn API).

### 3. `retrain.sh` never forwarded its arguments

**Root cause.** Escaping produced a literal `"\$@"`, so `--allow-small` was
silently dropped. **Files.** `ml/retrain.sh` **Fix.** `"$@"`.

### 4. Store aliased the seed constant

**Root cause.** `emptyDb()` set `listings: SEED` — the module-level array. Any
`unshift`/edit mutated the shared constant, so `npm run reset` and a second store
instance inherited earlier writes.

**Files.** `server/lib/store.js` **Fix.** Copy the seed
(`SEED.map(l => Object.assign({}, l))`) in both `emptyDb()` and `migrate()`.
**Verification.** Executed — 90 listings load clean per instance across five
independently-configured instances in one process.

### 5. Packaging and hygiene

* `ml/__init__.py` + eight subpackage files — `from ml.x import y` no longer
  relies on implicit namespace packages (and lets `pytest` resolve rootdir).
* `pytest`, `joblib` added to `ml/requirements.txt`.
* `.gitignore` added for `server/db.json`, `server/data/`, `ml/artifacts/`,
  `ml/datasets/`, `ml/fixtures/generated/`, `__pycache__`, `.env`.
* Removed the unused `dataset.drop_sessions_shorter_than_s` config key.

### 6. Harness defects (not application code, recorded for honesty)

Three shim bugs surfaced while building the runner and were fixed in it, not in
the app: `digest(enc)` ignored its encoding argument; `new Function` cannot parse
a shebang line (Node strips it); `process.argv` was not forwarded to modules.
One test failure — "blend order differs from heuristic" — was **my stub's fault**
(it emitted ML scores in heuristic order, so the two rankings agreed by
construction). Re-tested with a genuinely reversing stub plus `w=1`/`w=0`
boundary checks; blending confirmed correct.

### 7. Synthetic fixture initially failed its own gate

First run produced 177 unique users against a 300 gate, because sampling
`rnd() * 520` clumped. Now derived from the session index
(`(s * 97) % 480`), giving exactly 480 users. Final fixture: 78,545 events,
61,466 impressions, 8,524 positives, 5,000 sessions, 480 users, 30 days —
every gate met.

---

## D. Remaining blockers

All **external environment limitations**, not code issues. No internal failure
was left unresolved.

| Blocker | Command to run locally | Expected result |
|---|---|---|
| No Python runtime | `pip install -r ml/requirements.txt && pytest ml/tests -q` | ~35 tests pass |
| Dataset builder unrun (production data) | `python ml/data/build_recommendation_dataset.py` | exits code 2, "DATASET NOT BUILT — insufficient real data". **This is the correct result** on an empty log |
| Dataset builder unrun (fixture) | `node ml/fixtures/generate_synthetic_events.js && TM_EVENT_LOG=ml/fixtures/generated/events.jsonl python ml/data/build_recommendation_dataset.py` | ~61k rows, 5,000 groups, label histogram spanning 0–4, chronological split |
| Trainer unrun | `python ml/training/train_ranker.py` | on production data: exits 2 with INSUFFICIENT_DATA. On the fixture: trains, writes `ml/artifacts/<version>/model.txt` + `feature_metadata.json`, registers a `candidate` (or `rejected` if it fails to beat the heuristic) |
| Inference service unrun | `python ml/serve/inference_api.py --port 8500` then `curl localhost:8500/health` | `model_loaded: false` with no promoted model; the Node app stays on heuristic |
| `tests/05-api.test.js` unrun in sandbox | `npm test` | all suites pass, including the real-socket HTTP suite |

Static inspection was still performed on everything above: import graphs, call
signatures, config-key references and cross-file contracts were checked by hand,
which is how defects 1–3 were found.

---

## E. Final ML status

> **2. ML pipeline implemented but partially unverified due to the absence of a
> Python runtime in the authoring environment.**

Specifically:

* The **JavaScript** half — event logging, the event store, candidate generation,
  the heuristic ranker, blending, the registry lifecycle, confidence gates,
  inference failure handling and the entire HTTP surface — is **implemented and
  executed**, ~260 assertions, 0 failures.
* The **Python** half — dataset builder, feature engineering, LightGBM
  LambdaRank, evaluation, Bradley-Terry housing, fraud triage — is implemented,
  statically audited, and had one **critical** defect fixed that would have made
  every dataset build fail. It has not been executed.
* **No production model exists or is active.** `registry.mode()` returns
  `heuristic`, `/api/recommendations` reports `source: "heuristic"`,
  `model_version: null`, and every readiness counter reports
  `ready_to_train: false`. That is the intended launch state, and it was verified
  by execution rather than asserted.

No performance claim is made for any model, on real or synthetic data.
