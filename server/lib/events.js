/* Event taxonomy + validation + ingestion.

   Raw events are append-only. The label logic that turns them into ML targets
   lives in the Python pipeline (ml/data/labels.py), NOT here, so relevance
   grading can be redefined later without touching historical observations.
*/
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');
const log = require('./log');

/* ------------------------------------------------------------- taxonomy */

const DISCOVERY = ['impression', 'click', 'detail_view', 'search', 'filter_applied', 'category_view', 'map_view', 'skip'];
const ENGAGEMENT = ['dwell_30s', 'save', 'unsave', 'share', 'message_sent', 'reply_received', 'offer_sent', 'offer_accepted', 'meetup_requested', 'meetup_agreed'];
const OUTCOMES = ['marked_sold', 'marked_rented', 'transaction_confirmed', 'listing_expired', 'listing_removed'];
const SAFETY = ['report_submitted', 'listing_flagged', 'listing_removed_by_admin', 'user_blocked'];
const ROOMMATE = ['profile_view', 'mutual_interest', 'message_started', 'conversation_depth', 'meetup', 'match', 'move_in', 'lease_completion', 'satisfaction', 'conflict', 'early_termination'];
const HOUSING = ['pairwise_shown', 'pairwise_choice', 'pairwise_skip'];

/* Open by design: unknown types are accepted and recorded with a flag rather
   than rejected, so new instrumentation never needs a schema migration. */
const KNOWN = new Set([].concat(DISCOVERY, ENGAGEMENT, OUTCOMES, SAFETY, ROOMMATE, HOUSING));

const SURFACES = ['home', 'foryou', 'search', 'category', 'housing', 'similar', 'trending', 'detail', 'roommates', 'messages', 'admin'];

/* Positive-signal weighting reference, used by analytics only. The training
   pipeline computes its own labels from raw events. */
const SIGNAL_STRENGTH = {
  impression: 0, skip: 0, click: 1, detail_view: 1, dwell_30s: 1,
  save: 2, share: 2, message_sent: 3, reply_received: 3, offer_sent: 3,
  offer_accepted: 4, meetup_agreed: 4, transaction_confirmed: 4, marked_sold: 4, marked_rented: 4
};

/* ---------------------------------------------------------- normalisation */

function uuid() {
  return 'ev_' + crypto.randomBytes(9).toString('hex') + Date.now().toString(36);
}

/** Anonymous but stable per-user analytics id. Keeps identity data (email)
    out of the behavioural log — see docs/PRIVACY.md. */
function pseudonymise(email) {
  if (!email) return null;
  return 'u_' + crypto.createHash('sha256').update('tm|' + email).digest('hex').slice(0, 16);
}

const DROP_KEYS = ['password', 'token', 'authorization', 'auth', 'email', 'phone', 'message_text', 'body', 'text'];

function scrubMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  Object.keys(meta).slice(0, 30).forEach((k) => {
    if (DROP_KEYS.indexOf(String(k).toLowerCase()) >= 0) return;
    const v = meta[k];
    if (v === null || ['string', 'number', 'boolean'].indexOf(typeof v) >= 0) {
      out[k] = typeof v === 'string' ? v.slice(0, 240) : v;
    }
  });
  return out;
}

function validateEvent(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return ['event must be an object'];
  if (!raw.event_type || typeof raw.event_type !== 'string') errors.push('event_type is required');
  if (raw.surface && SURFACES.indexOf(raw.surface) < 0) errors.push('surface must be one of: ' + SURFACES.join(', '));
  if (raw.rank_position !== undefined && raw.rank_position !== null && typeof raw.rank_position !== 'number') errors.push('rank_position must be a number');
  if (raw.dwell_time_ms !== undefined && raw.dwell_time_ms !== null && typeof raw.dwell_time_ms !== 'number') errors.push('dwell_time_ms must be a number');
  if (raw.timestamp && typeof raw.timestamp !== 'number') errors.push('timestamp must be epoch milliseconds');
  return errors.length ? errors : null;
}

/**
 * Build the canonical stored record. Field set is fixed so the training
 * pipeline can rely on it; `metadata` absorbs anything experimental.
 */
function normalise(raw, ctx) {
  const now = Date.now();
  const ts = typeof raw.timestamp === 'number' && raw.timestamp > 0 && raw.timestamp <= now + 60000 ? raw.timestamp : now;
  return {
    event_id: raw.event_id || uuid(),
    schema_version: 1,
    user_id: ctx && ctx.userId ? ctx.userId : (raw.user_id ? String(raw.user_id).slice(0, 64) : null),
    session_id: raw.session_id ? String(raw.session_id).slice(0, 64) : null,
    listing_id: raw.listing_id ? String(raw.listing_id).slice(0, 64) : null,
    event_type: String(raw.event_type).slice(0, 48),
    known_type: KNOWN.has(raw.event_type),
    timestamp: ts,
    received_at: now,

    surface: raw.surface || null,
    rank_position: raw.rank_position === undefined ? null : raw.rank_position,
    viewport_visible: raw.viewport_visible === undefined ? null : !!raw.viewport_visible,

    query_text: raw.query_text ? String(raw.query_text).slice(0, 200) : null,
    filters_active: raw.filters_active && typeof raw.filters_active === 'object' ? scrubMetadata(raw.filters_active) : null,

    dwell_time_ms: raw.dwell_time_ms === undefined ? null : raw.dwell_time_ms,

    recommendation_source: raw.recommendation_source || null,
    model_version: raw.model_version || null,
    experiment_id: raw.experiment_id || null,
    variant: raw.variant || null,
    propensity: raw.propensity === undefined ? null : raw.propensity,
    original_rank: raw.original_rank === undefined ? null : raw.original_rank,
    served_rank: raw.served_rank === undefined ? null : raw.served_rank,

    device_type: raw.device_type || null,
    metadata: scrubMetadata(raw.metadata)
  };
}

/** Ingest a batch. Returns { accepted, rejected: [{index, errors}] }. */
function ingest(rows, ctx) {
  const accepted = [];
  const rejected = [];
  rows.slice(0, cfg.EVENT_BATCH_MAX).forEach((raw, i) => {
    const errs = validateEvent(raw);
    if (errs) { rejected.push({ index: i, errors: errs }); return; }
    const ev = normalise(raw, ctx);
    accepted.push(ev);
    store.aggregate(ev);
    if (!ev.known_type) log.bump('events.unknown_type');
  });
  if (accepted.length) store.appendEvents(accepted);
  return { accepted: accepted.length, rejected: rejected, event_ids: accepted.map((e) => e.event_id) };
}

/** Server-side emit for events the backend itself observes. */
function emit(event_type, fields, ctx) {
  return ingest([Object.assign({ event_type: event_type }, fields || {})], ctx);
}

module.exports = {
  DISCOVERY, ENGAGEMENT, OUTCOMES, SAFETY, ROOMMATE, HOUSING, SURFACES, SIGNAL_STRENGTH,
  KNOWN: Array.from(KNOWN), uuid, pseudonymise, validateEvent, normalise, ingest, emit, scrubMetadata
};
