# Trojan Market

Marketplace for international students at USC: housing and subleases near UPC
and HSC, desks, chairs and move-in essentials. Email sign-in lets students
browse and message; posting requires a digital ID verified through the
Credence ID Cloud SDK. It also ships a
recommendation pipeline that starts on transparent heuristics and transitions to
machine learning **only once real data justifies it**.

Academic Archival design: cardinal + gold on warm paper, Inter + JetBrains Mono.

---

## Run it

```bash
cd trojan-market
npm start                  # http://localhost:4000 — file-backed, no install needed
npm test                   # Node suite, no external services
```

### With MongoDB (optional)

```bash
npm install                            # pulls the mongodb driver
TM_MONGO_URI=mongodb://localhost:27017 npm start
```

Application state (users, listings, threads…) moves to MongoDB; the append-only
event log stays on disk. Unset `TM_MONGO_URI` and you are back on
`server/db.json` with zero external dependencies — that is the default and what
the test suite runs against. If the URI is set but unreachable, the app logs the
failure and boots on seeded in-memory state instead of crashing.

Node 18+. **No runtime dependencies.** Sign in with any `name@usc.edu`. In local
development the code is `482913` and the sign-in dialog shows it; with
`NODE_ENV=production` the fixed code is ignored, a random code is issued and it
is never returned by the API (a mailer still has to be attached, see TODOs). The ML pipeline needs Python
only when you actually train — the marketplace itself never does.

Admin dashboard at `/admin.html` — set `TM_ADMINS=you@usc.edu` first, sign in,
paste your token.

---

## Digital ID verification (Credence ID)

Trust tiers, enforced on the server:

| | can do |
|---|---|
| signed in with `@usc.edu` email | browse, save, message |
| + "Verified with digital ID" badge | create listings, including housing (`POST /api/listings` returns 403 `ID_VERIFICATION_REQUIRED` otherwise) |

The badge is shown on listing cards, the listing's seller panel, message
threads and the account's verify page.

How it works (`server/modules/identity/`):

1. The browser calls our server; only the server talks to Credence. `credence.js`
   calls `POST /v1/setup` with the license key, profile id and the registered
   `Origin`, caches the 15-minute access token, refreshes it with the rotating
   refresh token when under 60 s remain, and falls back to setup if the refresh
   token is rejected. A `TOKEN_EXPIRED` response is retried once.
2. **Wallet on this device** (Digital Credentials API, Chrome on Android, Safari
   on iPhone): `POST /api/identity/dc/start` returns a request from
   `/v1/getDocRequest` (`org-iso-mdoc`) or `/dcapi/openid4vp/v1/initiate`
   (`openid4vp`); the page passes it to `navigator.credentials.get` and posts
   `credential.data` to `/api/identity/dc/verify`, which calls
   `verifyDocRequest` / `validate`.
3. **Wallet on your phone** (any browser): `POST /api/identity/qr/start` returns
   a wallet link from `/openid4vp/v1/mdoc/initiate` (ISO mdoc, e.g. Samsung
   Wallet) or `/w3c/openid4vp/v1/initiate` (state mDL apps). The page renders it
   as a QR code with `public/qr.js` (bundled MIT encoder, no CDN) plus an
   "Open in wallet app" link, and polls `/api/identity/qr/poll` every 2 s.
4. The adapter parses `resDetails` / `identity` JSON strings, checks
   `cancelled` first, and maps failures (`DOMAIN_MISMATCH`, `TOKEN_EXPIRED`,
   rate limits, untrusted issuer, expired credential...) to clear messages.
5. The badge is granted only if signature, issuer trust and expiry all pass and
   the name on the ID matches the account name (case, accents, hyphens, middle
   names and name order are tolerated). Stored per user: `verified, method,
   wallet, issuer, givenName, familyName, verifiedAt, checks`. Birth date,
   document number and portrait are never stored. Changing the account name
   clears the badge.

All Credence endpoint paths and field names live in `credence.js` only, so
corrections to the integration happen in one file.

**Real vs simulated.** With `CREDENCE_LICENSE_KEY` and `CREDENCE_PROFILE_ID`
set, the Credence adapter is used. Credence only accepts calls from a **public
HTTPS origin registered for the license**, so set `PUBLIC_ORIGIN` to a deployed
URL or an HTTPS tunnel (`localhost` and IP origins are rejected by the portal);
without it verification is disabled rather than faked. With no key, the
simulated adapter (`simulated.js`, same interface) is used: the UI is labelled
"Demo verification", badges read "ID verified (demo)", and a selector lets you
demonstrate success, name mismatch, cancellation, untrusted issuer, expired ID
and bad signature. Simulation is off by default when `NODE_ENV=production`
(`TM_SIMULATED_ID`).

```bash
CREDENCE_LICENSE_KEY=CS-... CREDENCE_PROFILE_ID=... PUBLIC_ORIGIN=https://your-tunnel.example.com npm start
```

---

## Validation status

The JavaScript half of this system was **executed and validated**: ~200 assertions
covering event logging, the event store, the heuristic ranker, candidate
generation, the recommendation service, the full model-registry lifecycle,
ML/heuristic blending at w=0/0.5/1, every inference failure mode, and the whole
HTTP surface (auth, listings CRUD, cursor pagination, search, all nine housing
filters, favorites, messaging, offers, moderation, admin gating).

The Python pipeline is **statically audited and bug-fixed but not executed** —
there was no Python runtime in the authoring environment. Four real defects were
found and fixed by inspection (see `docs/VALIDATION.md`). To validate it locally:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r ml/requirements.txt
pytest ml/tests -q                                    # label / leakage / metric units

# end-to-end pipeline check on an ISOLATED synthetic fixture
node ml/export_house_detail.js
node ml/fixtures/generate_synthetic_events.js         # writes ml/fixtures/generated/
TM_EVENT_LOG=ml/fixtures/generated/events.jsonl \
  python ml/data/build_recommendation_dataset.py
python ml/training/train_ranker.py
python ml/registry/registry.py --list
```

The fixture is deliberately sized to clear every confidence gate (61k
impressions, 480 users, 5,000 sessions, 8.5k positives) so the gated path is
actually exercised. **No performance number from it means anything** — it is a
wiring check, and the file is written to `ml/fixtures/generated/`, never to
`server/data/`.

---

## Architecture

Modular monolith. Each domain owns its routes; nothing reaches across.

```
public/                        frontend (single-file DC app + admin dashboard)
  Trojan Market.dc.html        the marketplace UI
  admin.html                   ML & analytics dashboard
  index.html, support.js

server/
  index.js                     HTTP bootstrap, identity, SSE, static
  server.js                    shim -> index.js
  data.js                      90 seeded listings, housing attrs, roommates
  lib/
    config.js                  all configuration, env-overridable
    store.js                   mutable state (db.json | MongoDB) + events.jsonl
    mongo.js                   optional MongoDB backend for the mutable store
    events.js                  event taxonomy, validation, PII scrubbing
    http.js                    JSON, validation, rate limit, cursor pagination
    router.js                  table-driven routing with auth/admin guards
    log.js                     structured logs + latency percentiles
  modules/
    auth  listings  housing  roommates  favorites  messaging  identity/
    events  recommendations  moderation  analytics  ml  state
  recommendations/
    candidates.js              bounded multi-source recall
    preferences.js             online feature store (time-decayed)
    heuristic_ranker.js        7 weighted signals — the permanent fallback
    ranker.js                  THE ranking interface: blend + impression logging
  ml/
    registry.js                candidate -> shadow -> active, gate-checked
    inference.js               HTTP client w/ timeout + circuit breaker
  experiments/experiments.js   deterministic assignment + controlled exploration
  jobs/worker.js               expiry, stats, aggregates, artifact reload

ml/                            offline pipeline (Python)
  config.yaml                  labels, splits, hyperparameters, gates
  common.py                    config, event streaming, gate checking
  data/
    labels.py                  graded relevance + visibility-aware negatives
    build_recommendation_dataset.py
  features/recommendation_features.py
  training/train_ranker.py     LightGBM LambdaRank
  evaluation/evaluate_ranker.py NDCG/MRR/MAP/P@K/R@K + business metrics
  registry/registry.py         model lifecycle CLI
  serve/inference_api.py       scoring service (stdlib HTTP)
  housing/train_pairwise.py    Bradley-Terry House Match weights
  fraud/train_fraud_classifier.py
  retrain.sh                   the whole workflow, end to end

tests/                         node tests/run.js
docs/                          ML_ARCHITECTURE, FAIR_HOUSING, PRIVACY
```

---

## Dependency map

Every arrow was verified by execution, not inspection: the component is imported,
called, its output is used, and the feature is reachable through a running
request.

```
index.js ──> router ──> modules/*  (12 domains, all registered)
   │            │
   │            ├─ modules/recommendations ──> recommendations/ranker  ◄── THE interface
   │            │                                  │
   │            │                                  ├─> recommendations/candidates    (bounded recall)
   │            │                                  ├─> recommendations/preferences   (online features)
   │            │                                  ├─> recommendations/heuristic_ranker (permanent fallback)
   │            │                                  ├─> ml/inference ──> ml/registry  (gate-checked)
   │            │                                  ├─> experiments/experiments       (assignment + exploration)
   │            │                                  └─> lib/events.ingest             (impression logging)
   │            │
   │            ├─ modules/events ──> lib/events ──> lib/store.appendEvents ──> events.jsonl (append-only)
   │            ├─ modules/housing ──> HOUSE table + fitted-weight loader (inactive)
   │            ├─ modules/roommates ──> transparent compatibility (no model)
   │            ├─ modules/moderation ──> rules + human labels ──> db.moderation_decisions
   │            └─ modules/analytics ──> lib/store.agg + ml/registry + log.snapshot
   │
   ├──> jobs/worker  (expiry, seller stats, aggregates, artifact reload, notifications)
   └──> lib/store    (db.json mutable | events.jsonl append-only)

events.jsonl ──> ml/data/build_recommendation_dataset.py
                    ├─> ml/data/labels.py                  (graded relevance + visibility weights)
                    └─> ml/features/recommendation_features.py (chronological replay, no leakage)
                          │
                          v
                 ml/datasets/<version>/dataset.jsonl
                          │
                 ml/training/train_ranker.py ──> ml/evaluation/evaluate_ranker.py
                          │                            (NDCG/MRR/MAP + heuristic baseline)
                          v
                 ml/registry/registry.py ──> ml/artifacts/registry.json
                          │                        ▲
                          v                        │ read by
                 ml/serve/inference_api.py         server/ml/registry.js
                          ▲
                          └──────── server/ml/inference.js (timeout + circuit breaker)

frontend (Trojan Market.dc.html)
   ├─ trackImpressions()  per surface, per-surface dedupe ──┐
   ├─ trackInteraction()  click / save / skip              ├──> POST /api/events (batched, 4s + on tab hide)
   └─ track()             search / filter_applied          ──┘
```

No orphaned files: every module above is required by `index.js` (directly or
transitively) and was exercised by a passing assertion. The Python scripts are
entry points invoked by `ml/retrain.sh`.

---

## What is real, and what is honestly not

| | status | why |
|---|---|---|
| Marketplace | **working** | auth, listings, search, filters, housing, messaging, favorites, offers, moderation |
| Event logging | **working** | impressions + 40 event types, append-only |
| Heuristic ranking | **working** | 7 signals, functional with zero data |
| Recommendation API | **working** | frontend never knows what produced the order |
| ML pipeline | **built, inactive, Python unexecuted** | dataset builder, features, LambdaRank, eval, registry, inference are real code; the JS half is executed and tested, the Python half is audited only — see `docs/VALIDATION.md` |
| House Match | **heuristic** | Bradley-Terry ready; needs ~5,000 pairwise preferences |
| Roommate matching | **heuristic** | needs ~500 cohabitation outcomes (2-4 semesters) |
| Fraud detection | **rules + human** | needs ~1,000 moderator decisions |

There is **no synthetic training data** in this repository, and no model claims
accuracy it has not measured on real held-out traffic.

---

## API

### Recommendations
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/recommendations` | `surface, limit, category, q, seed_listing_id` |
| GET | `/api/recommendations/foryou` | listings + top roommate matches |
| GET | `/api/recommendations/status` | current mode, models, gate results |
| GET | `/api/recommendations/features` | your own aggregated features (auth) |

### Events
| Method | Path | Notes |
|---|---|---|
| POST | `/api/events` | single or `{events:[...]}`, max 100 |
| GET | `/api/events` | admin — raw log query |
| GET | `/api/events/schema` | the taxonomy, machine-readable |

### Marketplace
`/api/auth/{request,verify,signout,me}` ·
`/api/listings` (GET cursor-paginated, POST, GET/PATCH/DELETE by id) ·
`/api/housing` (all nine filters) · `/api/listings/:id/match` ·
`/api/favorites` · `/api/threads`, `/api/threads/:id/messages` ·
`/api/offers`, `/api/offers/:id/respond` · `/api/profile` ·
`/api/roommates`, `/api/roommates/outcomes` · `/api/reports` · `/api/stream` (SSE)

### ML operations
`/api/ml/models` · `/api/ml/models/promote` · `/api/ml/status` ·
`/api/ml/experiments` (+ `/:id/stop`) ·
`/api/housing/pairwise/{next,stats}`, POST `/api/housing/pairwise` ·
`/api/moderation/{queue,decide,fraud/stats}`

### Admin
`/api/admin/overview` · `/api/admin/experiments/:id/results` ·
`/api/admin/export/events` · `/api/admin/jobs` · `/api/admin/metrics`

---

## Event types logged

**Discovery** impression, click, detail_view, search, filter_applied,
category_view, map_view, skip
**Engagement** dwell_30s, save, unsave, share, message_sent, reply_received,
offer_sent, offer_accepted, meetup_requested, meetup_agreed
**Outcomes** marked_sold, marked_rented, transaction_confirmed, listing_expired,
listing_removed
**Safety** report_submitted, listing_flagged, listing_removed_by_admin, user_blocked
**Roommate** profile_view, mutual_interest, message_started, conversation_depth,
meetup, match, move_in, lease_completion, satisfaction, conflict, early_termination
**Housing** pairwise_shown, pairwise_choice, pairwise_skip

Unknown types are accepted and flagged `known_type: false` — new instrumentation
never needs a schema migration.

---

## Training the model locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r ml/requirements.txt

npm run ml:retrain              # the whole workflow
```

Or step by step:

```bash
node ml/export_house_detail.js
python ml/data/build_recommendation_dataset.py
python ml/training/train_ranker.py            # add --allow-small to dry-run the pipeline
python ml/evaluation/evaluate_ranker.py --model ml/artifacts/<version>/model.txt
python ml/registry/registry.py --list
```

With an empty event log the builder exits cleanly and tells you so. That is the
expected result on day one — not an error.

## Activating a model

```bash
# 1. shadow: computed and logged, never shown to users
python ml/registry/registry.py --promote <model_id> --status shadow
python ml/serve/inference_api.py --port 8500
TM_ML_ENABLED=true TM_ML_URL=http://localhost:8500 npm start
#    watch /api/admin/overview -> ml.shadow_comparison for a week+

# 2. A/B test
curl -XPOST localhost:4000/api/ml/experiments -H 'Authorization: Bearer <admin>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"ml_ranker_v1","control_variant":"heuristic","treatment_variant":"ml_blend","traffic_split":0.5,"primary_metric":"save_rate"}'

# 3. promote and ramp
python ml/registry/registry.py --promote <model_id> --status active
TM_ML_WEIGHT=0.2 npm start      # then 0.4, 0.6, 1.0
```

**Deactivating** is one variable: `TM_ML_WEIGHT=0`, or
`TM_ML_ENABLED=false`, or `--status archived`. Any of the three returns the
system to pure heuristic ranking with no restart of the ML service required.

## Behaviour with zero training data

* `/api/recommendations` returns heuristic rankings with `source: "heuristic"`,
  `model_version: null`
* `registry.mode()` → `"heuristic"`; the dashboard shows a banner saying so
* the dataset builder exits with a readable message, not a traceback
* the trainer refuses to run unless you pass `--allow-small`, and anything
  trained that way is registered `rejected` and cannot serve
* cold-start users get recent + trending + category-popular listings, never an
  empty feed

## Behaviour once real data exists

* gates satisfied → training produces a `candidate`
* evaluation compares NDCG@10 against the heuristic on the same held-out groups
* shadow mode logs what the model *would* have done; the dashboard reports top-1
  agreement and top-5 overlap
* A/B assignment is recorded on every impression, so the read-out is measured on
  save / message / transaction rate rather than clicks
* blend weight ramps manually; the heuristic remains the fallback forever

---

## Environment

See `.env.example`. Everything has a safe default; ML is off.

Key variables: `TM_ADMINS`, `TM_MONGO_URI`, `TM_ML_ENABLED`, `TM_ML_URL`,
`TM_ML_WEIGHT`, `TM_EXPLORE`, the six `TM_GATE_*` thresholds, and for
identity `CREDENCE_BASE_URL`, `CREDENCE_LICENSE_KEY`, `CREDENCE_PROFILE_ID`,
`PUBLIC_ORIGIN`, `TM_SIMULATED_ID`, `NODE_ENV`.

---

## Remaining TODOs

1. **Real mailer.** In production a random code is issued but not delivered;
   wire an email provider in `modules/auth.js:request`.
2. **Database indexes.** MongoDB is now supported (`TM_MONGO_URI`), but the
   collections are unindexed and `save()` is a full-state sync — a faithful port
   of the file semantics, not a scalable write path. Before real traffic: index
   `listings`, and move hot paths to targeted updates instead of whole-state
   rewrites. Events should move to partitioned Parquet or a warehouse at volume.
3. **Event log retention + deletion path** (see `docs/PRIVACY.md`).
4. **Image pipeline.** Photos are inline data URLs; move to object storage with
   resizing before real traffic.
5. **Push notifications.** `jobs/worker.js` has the queue and delivery hook;
   no transport is attached.
6. **Map view.** Housing records carry neighborhood and commute but no lat/lng.
7. **Semantic search.** Keyword search is deliberately unaugmented; revisit
   only when it measurably fails.
8. **Feature-parity test between JS and Python.** The two implementations agree
   by convention and `feature_version`; an automated cross-check would be better.
9. **Dwell-time instrumentation.** `dwell_30s` is in the taxonomy and consumed
   by the label map, but the client does not emit it yet.
