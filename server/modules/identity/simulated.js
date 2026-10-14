/* Simulated identity adapter: same interface as credence.js, no network.

   Used automatically when no Credence license key is configured so the whole
   product can be demonstrated locally. Every record it produces is stored with
   method 'simulated' and the UI labels it "Demo verification". The scenario is
   chosen by the person running the demo, so failure paths can be shown too. */
const crypto = require('crypto');

const SCENARIOS = {
  success: 'Wallet shares a valid ID that matches your account name',
  name_mismatch: 'Valid ID, but the name does not match your account',
  cancelled: 'You cancel in the wallet',
  untrusted_issuer: 'ID from an issuer that is not trusted',
  expired: 'Expired ID',
  bad_signature: 'Tampered credential (signature fails)'
};

const WALLETS = {
  'dc:mdoc': 'Demo wallet (ISO mdoc)',
  'dc:openid4vp': 'Demo wallet (OpenID4VP)',
  'qr:mdoc': 'Demo wallet (QR, ISO mdoc)',
  'qr:w3c': 'Demo wallet (QR, W3C VC)'
};

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { given: parts[0] || 'Tommy', family: 'Trojan' };
  return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] };
}

function outcomeFor(scenario, holderName, walletKey) {
  const n = splitName(holderName);
  const base = {
    status: 'verified',
    wallet: WALLETS[walletKey],
    issuer: 'Demo Motor Vehicles (simulated)',
    givenName: n.given,
    familyName: n.family,
    checks: { signature: true, issuerTrusted: true, notExpired: true }
  };
  switch (scenario) {
    case 'cancelled': return { status: 'cancelled', reason: 'CANCELLED', message: 'User denied consent.' };
    case 'name_mismatch': return Object.assign(base, { givenName: 'Alex', familyName: 'Sample' });
    case 'untrusted_issuer': return Object.assign(base, { issuer: 'Unknown issuer (simulated)', checks: { signature: true, issuerTrusted: false, notExpired: true } });
    case 'expired': return Object.assign(base, { checks: { signature: true, issuerTrusted: true, notExpired: false } });
    case 'bad_signature': return Object.assign(base, { checks: { signature: false, issuerTrusted: true, notExpired: true } });
    default: return base;
  }
}

function createSimulatedAdapter(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const qrDelayMs = o.qrDelayMs === undefined ? 4000 : o.qrDelayMs;
  const sessions = new Map();

  function open(kind, args) {
    const id = 'sim_' + crypto.randomBytes(12).toString('hex');
    const scenario = SCENARIOS[args && args.scenario] ? args.scenario : 'success';
    sessions.set(id, { kind: kind, flow: args.flow, scenario: scenario, holderName: args.holderName, created: now() });
    return id;
  }

  function take(id) {
    const s = sessions.get(id);
    if (s) sessions.delete(id);
    return s;
  }

  return {
    mode: 'simulated',
    scenarios: SCENARIOS,

    async startDc(args) {
      const flow = args && args.flow === 'mdoc' ? 'mdoc' : 'openid4vp';
      const id = open('dc', Object.assign({}, args, { flow: flow }));
      return { sessionId: id, protocol: flow === 'mdoc' ? 'org-iso-mdoc' : 'openid4vp', data: { simulated: true } };
    },

    async verifyDc(args) {
      const s = take(args.sessionId);
      if (!s || s.kind !== 'dc') return { status: 'failed', reason: 'SESSION_NOT_FOUND' };
      return outcomeFor(s.scenario, s.holderName, 'dc:' + s.flow);
    },

    async startQr(args) {
      const flow = args && args.flow === 'w3c' ? 'w3c' : 'mdoc';
      const id = open('qr', Object.assign({}, args, { flow: flow }));
      const request = 'https://demo.invalid/simulated/request/' + id;
      const walletUri = flow === 'mdoc'
        ? 'mdoc-openid4vp://?request_uri=' + encodeURIComponent(request)
        : 'openid4vp://authorize?client_id=' + encodeURIComponent('did:web:demo.invalid') + '&request_uri=' + encodeURIComponent(request);
      return { sessionId: id, walletUri: walletUri };
    },

    async pollQr(args) {
      const s = sessions.get(args.sessionId);
      if (!s || s.kind !== 'qr') return { status: 'failed', reason: 'SESSION_NOT_FOUND' };
      if (now() - s.created < qrDelayMs) return { status: 'pending' };
      take(args.sessionId);
      return outcomeFor(s.scenario, s.holderName, 'qr:' + s.flow);
    }
  };
}

module.exports = { createSimulatedAdapter, SCENARIOS };
