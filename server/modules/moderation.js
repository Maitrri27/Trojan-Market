/* Reports + moderation queue. Rules now, classifier later.

   Every moderator decision is recorded as a LABEL (0 safe / 1 confirmed
   scam) so ml/fraud/ has real training data when volume allows. Nothing is
   ever auto-banned by a score.
*/
const http = require('../lib/http');
const store = require('../lib/store');
const events = require('../lib/events');

/* Transparent rules. Produce a risk score used for QUEUE ORDER only. */
const RULES = [
  { id: 'price_too_good', weight: 0.3, test: (l) => l.category === 'housing' && Number(l.price) > 0 && Number(l.price) < 500 },
  { id: 'no_photo', weight: 0.1, test: (l) => !l.photo && !l.kw },
  { id: 'thin_description', weight: 0.15, test: (l) => String(l.description || '').length < 25 },
  { id: 'offsite_contact', weight: 0.25, test: (l) => /(whatsapp|telegram|wire transfer|zelle only|western union)/i.test(String(l.description || '')) },
  { id: 'urgency_language', weight: 0.15, test: (l) => /(act now|today only|must wire|deposit immediately)/i.test(String(l.description || '')) },
  { id: 'new_seller_high_value', weight: 0.2, test: (l) => Number(l.price) > 1500 && (l.created_at || 0) > Date.now() - 86400000 }
];

function riskScore(listing) {
  const fired = RULES.filter((r) => { try { return r.test(listing); } catch (e) { return false; } });
  const score = Math.min(1, fired.reduce((n, r) => n + r.weight, 0));
  return { risk_score: Number(score.toFixed(3)), rules_fired: fired.map((r) => r.id), method: 'rules' };
}

async function report(ctx) {
  const b = await http.readBody(ctx.req);
  const errs = http.validate(b, {
    listingId: { type: 'string', required: true },
    reason: { type: 'string', required: true, max: 200 }
  });
  if (errs) return http.badRequest(ctx.res, 'Invalid report.', errs);
  const row = {
    report_id: 'rp' + Date.now(),
    listingId: b.listingId, reason: b.reason,
    by: ctx.user.email, at: Date.now(), status: 'open'
  };
  store.db.reports.push(row);
  store.save();
  events.emit('report_submitted', { user_id: ctx.analyticsId, listing_id: b.listingId, surface: 'detail', metadata: { reason: b.reason } }, { userId: ctx.analyticsId });
  return http.created(ctx.res, { ok: true, report_id: row.report_id });
}

async function queue(ctx) {
  const open = (store.db.reports || []).filter((r) => r.status === 'open');
  const rows = open.map((r) => {
    const l = store.db.listings.filter((x) => x.id === r.listingId)[0] || null;
    return { report: r, listing: l, risk: l ? riskScore(l) : null };
  }).sort((a, b) => ((b.risk && b.risk.risk_score) || 0) - ((a.risk && a.risk.risk_score) || 0));
  return http.ok(ctx.res, { count: rows.length, queue: rows, scoring: 'rules_only', classifier: null });
}

async function decide(ctx) {
  const b = await http.readBody(ctx.req);
  const errs = http.validate(b, {
    report_id: { type: 'string', required: true },
    decision: { type: 'string', required: true, enum: ['safe', 'scam', 'spam', 'policy_violation'] }
  });
  if (errs) return http.badRequest(ctx.res, 'Invalid decision.', errs);
  const r = (store.db.reports || []).filter((x) => x.report_id === b.report_id)[0];
  if (!r) return http.notFound(ctx.res, 'Report not found.');
  const listing = store.db.listings.filter((x) => x.id === r.listingId)[0];
  r.status = 'resolved';
  r.decision = b.decision;
  r.resolved_by = ctx.user.email;
  r.resolved_at = Date.now();

  /* the moderation label — this is the fraud model's y */
  store.db.moderation_decisions.push({
    decision_id: 'md' + Date.now(),
    listing_id: r.listingId,
    label: b.decision === 'safe' ? 0 : 1,
    decision: b.decision,
    rules_at_decision: listing ? riskScore(listing) : null,
    listing_snapshot: listing ? {
      price: listing.price, category: listing.category,
      description_length: String(listing.description || '').length,
      has_photo: !!listing.photo, seller_email_hash: null
    } : null,
    at: Date.now()
  });

  if (b.decision !== 'safe' && listing) {
    listing.removed = true;
    events.emit('listing_removed_by_admin', { listing_id: listing.id, surface: 'admin' }, {});
  }
  store.save();
  return http.ok(ctx.res, { ok: true, report: r });
}

async function fraudStats(ctx) {
  const rows = store.db.moderation_decisions || [];
  const positives = rows.filter((r) => r.label === 1).length;
  const MIN = 1000;
  return http.ok(ctx.res, {
    labeled_decisions: rows.length,
    confirmed_bad: positives,
    confirmed_safe: rows.length - positives,
    minimum_for_training: MIN,
    ready_to_train: rows.length >= MIN && positives >= 100,
    active_classifier: null,
    note: 'Moderation is rules + human review. A classifier would assist triage only, never auto-ban.'
  });
}

module.exports = {
  riskScore, RULES,
  routes: [
    { method: 'POST', path: '/api/reports', handler: report, opts: { auth: true } },
    { method: 'GET', path: '/api/moderation/queue', handler: queue, opts: { admin: true } },
    { method: 'POST', path: '/api/moderation/decide', handler: decide, opts: { admin: true } },
    { method: 'GET', path: '/api/moderation/fraud/stats', handler: fraudStats }
  ]
};
