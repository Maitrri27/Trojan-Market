/* Digital ID verification: adapter selection, HTTP routes and trust tiers.

   Trust tiers
     signed in with @usc.edu email      browse, save, message
     + "Verified with digital ID"       create listings (including housing)

   The browser never talks to Credence and never sees the license key. It asks
   this server for a request, hands that request to the wallet (Digital
   Credentials API) or shows it as a QR code / deep link, and returns the wallet
   response here. The decision is made server-side from the adapter outcome. */
const cfg = require('../../lib/config');
const http = require('../../lib/http');
const store = require('../../lib/store');
const log = require('../../lib/log');
const { createCredenceAdapter, CredenceError } = require('./credence');
const { createSimulatedAdapter } = require('./simulated');
const record = require('./record');

const SESSION_TTL_MS = 10 * 60 * 1000;
const DC_FLOWS = ['mdoc', 'openid4vp'];
const QR_FLOWS = ['mdoc', 'w3c'];

function selectAdapter(c, deps) {
  const d = deps || {};
  if (c.CREDENCE_LICENSE_KEY && c.CREDENCE_PROFILE_ID) {
    try {
      return createCredenceAdapter({
        baseUrl: c.CREDENCE_BASE_URL, licenseKey: c.CREDENCE_LICENSE_KEY, profileId: c.CREDENCE_PROFILE_ID,
        origin: c.PUBLIC_ORIGIN, timeoutMs: c.CREDENCE_TIMEOUT_MS, fetch: d.fetch, now: d.now
      });
    } catch (e) {
      if (d.onError) d.onError(e);
      return null;
    }
  }
  if (!c.SIMULATED_ID_ENABLED) return null;
  return createSimulatedAdapter({ now: d.now, qrDelayMs: d.qrDelayMs });
}

let adapter = selectAdapter(cfg, { onError: (e) => log.error('identity', 'Credence ID is misconfigured; verification disabled', e) });
const sessions = new Map();

function setAdapter(a) { adapter = a; sessions.clear(); }
function getAdapter() { return adapter; }
function mode() { return adapter ? adapter.mode : 'disabled'; }

/* ------------------------------------------------------------ trust tiers */

function identityOf(email) {
  const u = email && store.db.users[email];
  return u && u.identity && u.identity.verified ? u.identity : null;
}

function isVerified(email) { return !!identityOf(email); }

/** Sends a 403 and returns false when the signed-in user has no ID badge. */
function requireVerified(ctx) {
  if (ctx.user && isVerified(ctx.user.email)) return true;
  http.json(ctx.res, 403, {
    error: 'Verify with a digital ID before posting listings or housing. Signed-in students can still browse and message.',
    code: 'ID_VERIFICATION_REQUIRED'
  });
  return false;
}

/** Public view of a listing: adds the seller's badge, never their identity data. */
function publicListing(l) {
  const id = identityOf(l.email);
  return Object.assign({}, l, { seller_verified: !!id, seller_verification: id ? id.method : null });
}

function publicThread(t, me) {
  const id = identityOf((t.members || []).filter((m) => m !== me)[0] || t.email);
  return Object.assign({}, t, { peer_verified: !!id, peer_verification: id ? id.method : null });
}

function publicRecord(r) {
  if (!r) return null;
  return { verified: true, method: r.method, wallet: r.wallet, issuer: r.issuer, verifiedAt: r.verifiedAt, checks: r.checks };
}

/* ------------------------------------------------------------ sessions */

function sweep() {
  const t = Date.now();
  sessions.forEach((s, id) => { if (t - s.created > SESSION_TTL_MS) sessions.delete(id); });
}

function openSession(ctx, kind, flow, id) {
  sweep();
  sessions.set(id, { email: ctx.user.email, kind: kind, flow: flow, created: Date.now() });
}

function ownSession(ctx, kind, id) {
  sweep();
  const s = sessions.get(String(id || ''));
  return s && s.kind === kind && s.email === ctx.user.email ? s : null;
}

/* ------------------------------------------------------------ handlers */

function unavailable(res) {
  return http.json(res, 503, { error: 'Digital ID verification is not configured on this server.', code: 'ID_VERIFICATION_DISABLED' });
}

function upstream(res, e) {
  if (e instanceof CredenceError) {
    log.warn('identity', 'Credence ID error ' + e.code + ' (' + e.status + ')');
    return http.json(res, 502, { error: e.message, code: e.code });
  }
  throw e;
}

function finish(ctx, outcome) {
  const user = store.db.users[ctx.user.email];
  const result = record.evaluate(outcome, user && user.name, adapter.mode);
  if (result.status === 'verified') {
    user.identity = result.record;
    store.save();
    log.info('identity', 'digital ID verified (' + adapter.mode + ')');
    return http.ok(ctx.res, { status: 'verified', identity: publicRecord(result.record) });
  }
  return http.ok(ctx.res, result);
}

async function status(ctx) {
  const user = store.db.users[ctx.user.email] || {};
  return http.ok(ctx.res, {
    mode: mode(),
    demo: mode() === 'simulated',
    verified: isVerified(ctx.user.email),
    identity: publicRecord(identityOf(ctx.user.email)),
    displayName: user.name || null,
    flows: { dc: DC_FLOWS, qr: QR_FLOWS },
    scenarios: adapter && adapter.scenarios ? adapter.scenarios : null
  });
}

async function dcStart(ctx) {
  if (!adapter) return unavailable(ctx.res);
  const b = await http.readBody(ctx.req);
  const flow = DC_FLOWS.indexOf(b.flow) >= 0 ? b.flow : 'openid4vp';
  try {
    const user = store.db.users[ctx.user.email] || {};
    const r = await adapter.startDc({ flow: flow, scenario: b.scenario, holderName: user.name });
    if (!r || !r.sessionId) return http.json(ctx.res, 502, { error: 'The verification service returned no session.', code: 'UPSTREAM_ERROR' });
    openSession(ctx, 'dc', flow, r.sessionId);
    return http.ok(ctx.res, { sessionId: r.sessionId, flow: flow, protocol: r.protocol, data: r.data, demo: adapter.mode === 'simulated' });
  } catch (e) { return upstream(ctx.res, e); }
}

async function dcVerify(ctx) {
  if (!adapter) return unavailable(ctx.res);
  const b = await http.readBody(ctx.req);
  const s = ownSession(ctx, 'dc', b.sessionId);
  if (!s) return http.ok(ctx.res, { status: 'failed', reason: 'SESSION_NOT_FOUND', message: record.reasonMessage('SESSION_NOT_FOUND') });
  sessions.delete(b.sessionId);
  try {
    return finish(ctx, await adapter.verifyDc({ flow: s.flow, sessionId: b.sessionId, data: b.data }));
  } catch (e) { return upstream(ctx.res, e); }
}

async function qrStart(ctx) {
  if (!adapter) return unavailable(ctx.res);
  const b = await http.readBody(ctx.req);
  const flow = QR_FLOWS.indexOf(b.flow) >= 0 ? b.flow : 'mdoc';
  try {
    const user = store.db.users[ctx.user.email] || {};
    const r = await adapter.startQr({
      flow: flow, scenario: b.scenario, holderName: user.name,
      returnUrl: cfg.PUBLIC_ORIGIN ? cfg.PUBLIC_ORIGIN.replace(/\/+$/, '') + '/' : undefined
    });
    if (!r || !r.sessionId || !r.walletUri) return http.json(ctx.res, 502, { error: 'The verification service returned no wallet link.', code: 'UPSTREAM_ERROR' });
    openSession(ctx, 'qr', flow, r.sessionId);
    return http.ok(ctx.res, { sessionId: r.sessionId, flow: flow, walletUri: r.walletUri, pollMs: 2000, demo: adapter.mode === 'simulated' });
  } catch (e) { return upstream(ctx.res, e); }
}

async function qrPoll(ctx) {
  if (!adapter) return unavailable(ctx.res);
  const b = await http.readBody(ctx.req);
  const s = ownSession(ctx, 'qr', b.sessionId);
  if (!s) return http.ok(ctx.res, { status: 'failed', reason: 'SESSION_NOT_FOUND', message: record.reasonMessage('SESSION_NOT_FOUND') });
  try {
    const outcome = await adapter.pollQr({ flow: s.flow, sessionId: b.sessionId });
    if (outcome.status === 'pending') return http.ok(ctx.res, { status: 'pending' });
    sessions.delete(b.sessionId);
    return finish(ctx, outcome);
  } catch (e) { return upstream(ctx.res, e); }
}

/* Changing the display name re-opens the name match, so it clears the badge. */
async function setName(ctx) {
  const b = await http.readBody(ctx.req);
  const name = String(b.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 80 || record.tokens(name).length < 2) {
    return http.badRequest(ctx.res, 'Enter your first and last name as they appear on your ID.');
  }
  const user = store.db.users[ctx.user.email];
  if (!user) return http.unauthorized(ctx.res);
  if (user.name !== name) {
    user.name = name;
    delete user.identity;
    store.db.listings.forEach((l) => { if (l.email === user.email) l.seller = name; });
    store.save();
  }
  return http.ok(ctx.res, { user: user, verified: isVerified(user.email) });
}

module.exports = {
  selectAdapter, setAdapter, getAdapter, mode,
  isVerified, requireVerified, publicListing, publicThread, publicRecord,
  routes: [
    { method: 'GET', path: '/api/identity/status', handler: status, opts: { auth: true } },
    { method: 'POST', path: '/api/identity/dc/start', handler: dcStart, opts: { auth: true } },
    { method: 'POST', path: '/api/identity/dc/verify', handler: dcVerify, opts: { auth: true } },
    { method: 'POST', path: '/api/identity/qr/start', handler: qrStart, opts: { auth: true } },
    { method: 'POST', path: '/api/identity/qr/poll', handler: qrPoll, opts: { auth: true } },
    { method: 'POST', path: '/api/identity/name', handler: setName, opts: { auth: true } }
  ]
};
