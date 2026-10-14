/* Event ingestion API — Phase 2. */
const http = require('../lib/http');
const events = require('../lib/events');
const store = require('../lib/store');
const cfg = require('../lib/config');

async function post(ctx) {
  let payload;
  try { payload = await http.readBody(ctx.req, 2e6); } catch (e) { return http.badRequest(ctx.res, e.message); }
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.events) ? payload.events : [payload]);
  if (!rows.length) return http.badRequest(ctx.res, 'No events supplied.');
  if (rows.length > cfg.EVENT_BATCH_MAX) return http.badRequest(ctx.res, 'Batch exceeds ' + cfg.EVENT_BATCH_MAX + ' events.');

  const result = events.ingest(rows, { userId: ctx.analyticsId });
  const code = result.accepted === 0 ? 400 : (result.rejected.length ? 207 : 202);
  return http.json(ctx.res, code, {
    accepted: result.accepted,
    rejected: result.rejected.length,
    errors: result.rejected,
    event_ids: result.event_ids
  });
}

/* Read-side, admin only: raw events are behavioural data. */
async function query(ctx) {
  const s = ctx.url.searchParams;
  const rows = store.readEvents({
    since: s.get('since') ? Number(s.get('since')) : null,
    until: s.get('until') ? Number(s.get('until')) : null,
    event_type: s.get('event_type'),
    surface: s.get('surface'),
    user_id: s.get('user_id'),
    limit: Math.min(5000, Number(s.get('limit')) || 500)
  });
  return http.ok(ctx.res, { count: rows.length, total_logged: store.eventTotal(), events: rows });
}

async function schema(ctx) {
  return http.ok(ctx.res, {
    event_types: {
      discovery: events.DISCOVERY, engagement: events.ENGAGEMENT,
      outcomes: events.OUTCOMES, safety: events.SAFETY,
      roommate: events.ROOMMATE, housing: events.HOUSING
    },
    surfaces: events.SURFACES,
    required_fields: ['event_type'],
    recorded_fields: Object.keys(events.normalise({ event_type: 'impression' }, {})),
    note: 'Unknown event types are accepted and flagged (known_type=false) rather than rejected.'
  });
}

module.exports = {
  routes: [
    { method: 'POST', path: '/api/events', handler: post },
    { method: 'GET', path: '/api/events', handler: query, opts: { admin: true } },
    { method: 'GET', path: '/api/events/schema', handler: schema }
  ]
};
