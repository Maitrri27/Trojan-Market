/* Central configuration. Everything overridable by environment variable. */
const os = require('os');
const path = require('path');

const num = (k, d) => (process.env[k] === undefined ? d : Number(process.env[k]));
const bool = (k, d) => (process.env[k] === undefined ? d : /^(1|true|yes)$/i.test(process.env[k]));
const str = (k, d) => (process.env[k] === undefined ? d : process.env[k]);

const SERVER_DIR = path.join(__dirname, '..');
const ROOT = path.join(SERVER_DIR, '..');

/* Vercel: serverless functions, read-only filesystem outside /tmp, ephemeral
   instances. Runtime files move to the temp dir; explicit env vars still win. */
const IS_VERCEL = !!process.env.VERCEL;
const RUNTIME_DIR = IS_VERCEL ? path.join(os.tmpdir(), 'trojan-market') : null;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

module.exports = {
  PORT: num('PORT', 4000),
  ROOT: ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  IS_VERCEL: IS_VERCEL,
  DATA_DIR: str('TM_DATA_DIR', path.join(RUNTIME_DIR || SERVER_DIR, 'data')),
  DB_FILE: str('TM_DB_FILE', path.join(RUNTIME_DIR || SERVER_DIR, 'db.json')),
  EVENT_LOG: str('TM_EVENT_LOG', path.join(RUNTIME_DIR || SERVER_DIR, 'data', 'events.jsonl')),

  /* MongoDB — OPT-IN. Unset means the file-backed store above is used, which
     needs no external service and is what the test suite runs against. */
  MONGO_URI: str('TM_MONGO_URI', ''),
  MONGO_DB: str('TM_MONGO_DB', 'trojan_market'),
  MONGO_TIMEOUT_MS: num('TM_MONGO_TIMEOUT_MS', 5000),
  MODEL_DIR: str('TM_MODEL_DIR', path.join(ROOT, 'ml', 'artifacts')),
  REGISTRY_FILE: str('TM_REGISTRY_FILE', path.join(RUNTIME_DIR || path.join(ROOT, 'ml', 'artifacts'), 'registry.json')),

  IS_PRODUCTION: IS_PRODUCTION,

  /* auth. The fixed demo code is a local-development convenience only: it is
     ignored, and never returned to the client, when NODE_ENV=production.
     On Vercel NODE_ENV is production, so there the demo code is controlled by
     TM_DEMO_CODE alone: set means enabled, unset means disabled. */
  AUTH_EMAIL_DOMAIN: str('TM_EMAIL_DOMAIN', 'usc.edu'),
  DEMO_AUTH_CODE: str('TM_DEMO_CODE', IS_PRODUCTION || IS_VERCEL ? '' : '482913'),
  DEMO_CODE_EXPLICIT: IS_VERCEL && !!process.env.TM_DEMO_CODE,
  SESSION_TTL_MS: num('TM_SESSION_TTL_MS', 30 * 24 * 3600 * 1000),

  /* Stateless sessions: HMAC-signed tokens that any instance can verify, so a
     sign-in survives a request landing on a different serverless instance.
     On by default on Vercel only. */
  STATELESS_SESSIONS: bool('TM_STATELESS_SESSIONS', IS_VERCEL),
  SESSION_SECRET: str('TM_SESSION_SECRET', ''),

  /* identity verification (Credence ID Cloud SDK). With no license key the
     simulated adapter is used and the UI labels it as a demo. */
  CREDENCE_BASE_URL: str('CREDENCE_BASE_URL', 'https://credenceid.com/cloudsdk/playground'),
  CREDENCE_LICENSE_KEY: str('CREDENCE_LICENSE_KEY', ''),
  CREDENCE_PROFILE_ID: str('CREDENCE_PROFILE_ID', ''),
  PUBLIC_ORIGIN: str('PUBLIC_ORIGIN', ''),
  CREDENCE_TIMEOUT_MS: num('CREDENCE_TIMEOUT_MS', 15000),
  SIMULATED_ID_ENABLED: bool('TM_SIMULATED_ID', !IS_PRODUCTION && !IS_VERCEL),

  /* recommendations */
  REC_DEFAULT_LIMIT: num('TM_REC_LIMIT', 20),
  REC_CANDIDATE_POOL: num('TM_REC_POOL', 400),
  ML_MODEL_WEIGHT: num('TM_ML_WEIGHT', 0),           // 0 = pure heuristic (cold start)
  ML_INFERENCE_URL: str('TM_ML_URL', ''),            // e.g. http://localhost:8500
  ML_INFERENCE_TIMEOUT_MS: num('TM_ML_TIMEOUT_MS', 120),
  ML_ENABLED: bool('TM_ML_ENABLED', false),

  /* confidence gates — an ML model stays inactive until ALL are satisfied */
  GATES: {
    minimum_training_examples: num('TM_GATE_EXAMPLES', 50000),
    minimum_unique_users: num('TM_GATE_USERS', 300),
    minimum_unique_sessions: num('TM_GATE_SESSIONS', 2000),
    minimum_positive_events: num('TM_GATE_POSITIVES', 2000),
    minimum_test_score: num('TM_GATE_NDCG', 0.30),
    minimum_improvement_over_baseline: num('TM_GATE_LIFT', 0.02)
  },

  /* controlled exploration for position-bias correction */
  EXPLORATION_ENABLED: bool('TM_EXPLORE', false),
  EXPLORATION_TRAFFIC: num('TM_EXPLORE_TRAFFIC', 0.05),
  EXPLORATION_SWAP_DEPTH: num('TM_EXPLORE_DEPTH', 5),

  /* ingestion + safety */
  EVENT_BATCH_MAX: num('TM_EVENT_BATCH_MAX', 100),
  RATE_LIMIT_WINDOW_MS: num('TM_RATE_WINDOW_MS', 10000),
  RATE_LIMIT_MAX: num('TM_RATE_MAX', 300),
  ADMIN_EMAILS: str('TM_ADMINS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  /* jobs */
  JOB_INTERVAL_MS: num('TM_JOB_INTERVAL_MS', 60000)
};
