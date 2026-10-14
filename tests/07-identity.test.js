/* Digital ID verification: adapter selection, Credence token lifecycle and
   response parsing (mocked fetch), name matching, server-side gating, and the
   demo sign-in code never leaking in production. */
const http = require('http');
const identity = require('../server/modules/identity');
const { createCredenceAdapter, CredenceError, parseDcResult, parseMdocQrResult, parseW3cResult } = require('../server/modules/identity/credence');
const { createSimulatedAdapter } = require('../server/modules/identity/simulated');
const record = require('../server/modules/identity/record');
const cfg = require('../server/lib/config');

const PORT = Number(process.env.PORT || 4123);
const KEY = 'CS-TEST-00000000-0000-0000-0000-000000000000';
const PROFILE = '9b2f6c1e-0000-4000-8000-000000000001';
const ORIGIN = 'https://market.example.org';

/* ---------------------------------------------------------------- helpers */

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const path = url.replace(/^https:\/\/[^/]+\/cloudsdk\/playground/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: path, headers: init.headers, body: body });
    const h = routes[path];
    if (!h) throw new Error('unexpected call ' + path);
    const r = typeof h === 'function' ? h(body, init.headers, calls) : h;
    return { status: r.status || 200, text: async () => JSON.stringify(r.json || {}) };
  };
  fn.calls = calls;
  return fn;
}

function tokenPair(n, expiresIn) {
  return { status: 200, json: { accessToken: 'at' + n, refreshToken: 'rt_' + n, expiresIn: expiresIn || 900, tokenType: 'Bearer' } };
}

function adapterWith(routes, clock) {
  const f = mockFetch(routes);
  const a = createCredenceAdapter({
    baseUrl: 'https://credenceid.com/cloudsdk/playground', licenseKey: KEY, profileId: PROFILE,
    origin: ORIGIN, fetch: f, now: () => clock.t
  });
  return { a: a, f: f };
}

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: path, method: method, headers: headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function signIn(email, name) {
  await req('POST', '/api/auth/request', { email: email });
  const v = await req('POST', '/api/auth/verify', { email: email, code: '482913' });
  if (name) await req('POST', '/api/identity/name', { name: name }, v.body.token);
  return v.body.token;
}

async function dcVerify(token, scenario) {
  const s = await req('POST', '/api/identity/dc/start', { flow: 'openid4vp', scenario: scenario }, token);
  return req('POST', '/api/identity/dc/verify', { sessionId: s.body.sessionId, data: 'wallet-response' }, token);
}

/* ------------------------------------------------------------ unit: adapters */

describe('identity adapter selection', () => {
  const base = { CREDENCE_BASE_URL: 'https://credenceid.com/cloudsdk/playground', CREDENCE_TIMEOUT_MS: 1000, SIMULATED_ID_ENABLED: true };

  it('uses the simulated adapter when no license key is set', () => {
    const a = identity.selectAdapter(Object.assign({}, base, { CREDENCE_LICENSE_KEY: '', CREDENCE_PROFILE_ID: '' }));
    assert.eq(a.mode, 'simulated');
  });

  it('uses Credence when key, profile and https origin are set', () => {
    const a = identity.selectAdapter(Object.assign({}, base, { CREDENCE_LICENSE_KEY: KEY, CREDENCE_PROFILE_ID: PROFILE, PUBLIC_ORIGIN: ORIGIN }));
    assert.eq(a.mode, 'credence-cloud');
  });

  it('disables verification when a key is set without an https origin', () => {
    let err = null;
    const a = identity.selectAdapter(Object.assign({}, base, { CREDENCE_LICENSE_KEY: KEY, CREDENCE_PROFILE_ID: PROFILE, PUBLIC_ORIGIN: 'http://localhost:4000' }), { onError: (e) => { err = e; } });
    assert.eq(a, null);
    assert.ok(err && /PUBLIC_ORIGIN/.test(err.message));
  });

  it('never simulates when simulation is turned off (production default)', () => {
    const a = identity.selectAdapter(Object.assign({}, base, { CREDENCE_LICENSE_KEY: '', SIMULATED_ID_ENABLED: false }));
    assert.eq(a, null);
  });
});

describe('credence token lifecycle', () => {
  it('sets up once with license key, profile and Origin, then reuses the token', async () => {
    const clock = { t: 1e12 };
    const { a, f } = adapterWith({ '/v1/setup': tokenPair(1), '/dcapi/openid4vp/v1/initiate': { json: { sessionId: 's1', payload: { dcql: 1 } } } }, clock);
    await a.startDc({ flow: 'openid4vp' });
    await a.startDc({ flow: 'openid4vp' });
    const setups = f.calls.filter((c) => c.path === '/v1/setup');
    assert.eq(setups.length, 1);
    assert.eq(setups[0].body, { licenseKey: KEY, profileId: PROFILE });
    assert.eq(setups[0].headers.Origin, ORIGIN);
    const api = f.calls.filter((c) => c.path !== '/v1/setup');
    assert.eq(api[1].headers.Authorization, 'Bearer at1');
  });

  it('refreshes when under 60s remain, with the rotated refresh token', async () => {
    const clock = { t: 1e12 };
    let n = 1;
    const { a, f } = adapterWith({
      '/v1/setup': tokenPair(1),
      '/v1/refresh': (body) => tokenPair(++n),
      '/v1/getDocRequest': { status: 201, json: { sessionId: 's', dcRequest: { deviceRequest: 'dr', encryptionInfo: 'ei' } } }
    }, clock);
    await a.startDc({ flow: 'mdoc' });
    clock.t += 850 * 1000;
    await a.startDc({ flow: 'mdoc' });
    clock.t += 850 * 1000;
    await a.startDc({ flow: 'mdoc' });
    const refreshes = f.calls.filter((c) => c.path === '/v1/refresh');
    assert.eq(refreshes.map((c) => c.body.refreshToken), ['rt_1', 'rt_2']);
    assert.eq(f.calls[f.calls.length - 1].headers.Authorization, 'Bearer at3');
  });

  it('falls back to setup when the refresh token is rejected', async () => {
    const clock = { t: 1e12 };
    let setups = 0;
    const { a } = adapterWith({
      '/v1/setup': () => tokenPair(10 + (++setups)),
      '/v1/refresh': { status: 401, json: { code: 'REFRESH_TOKEN_EXPIRED' } },
      '/v1/getDocRequest': { json: { sessionId: 's', dcRequest: {} } }
    }, clock);
    await a.startDc({ flow: 'mdoc' });
    clock.t += 899 * 1000;
    await a.startDc({ flow: 'mdoc' });
    assert.eq(setups, 2);
  });

  it('retries once with a fresh token on TOKEN_EXPIRED', async () => {
    const clock = { t: 1e12 };
    let n = 0;
    const { a, f } = adapterWith({
      '/v1/setup': () => tokenPair(++n),
      '/v1/refresh': () => tokenPair(++n),
      '/openid4vp/v1/mdoc/initiate': (b, h) => h.Authorization === 'Bearer at1'
        ? { status: 401, json: { code: 'TOKEN_EXPIRED' } }
        : { json: { sessionId: 'q1', walletUri: 'mdoc-openid4vp://?request_uri=x' } }
    }, clock);
    const r = await a.startQr({ flow: 'mdoc' });
    assert.eq(r.walletUri, 'mdoc-openid4vp://?request_uri=x');
    assert.eq(f.calls.filter((c) => c.path === '/openid4vp/v1/mdoc/initiate').length, 2);
  });

  it('surfaces DOMAIN_MISMATCH and rate limits as typed errors', async () => {
    const clock = { t: 1e12 };
    const { a } = adapterWith({ '/v1/setup': { status: 403, json: { code: 'DOMAIN_MISMATCH', message: 'Origin not registered' } } }, clock);
    let e = null;
    try { await a.startDc({ flow: 'openid4vp' }); } catch (x) { e = x; }
    assert.ok(e instanceof CredenceError);
    assert.eq(e.code, 'DOMAIN_MISMATCH');
    assert.eq(e.status, 403);

    const b = adapterWith({ '/v1/setup': tokenPair(1), '/w3c/openid4vp/v1/initiate': { status: 429, json: { code: 'RATE_LIMIT_EXCEEDED' } } }, clock).a;
    let e2 = null;
    try { await b.startQr({ flow: 'w3c' }); } catch (x) { e2 = x; }
    assert.eq(e2.code, 'RATE_LIMIT_EXCEEDED');
  });

  it('never returns the license key in anything handed to the browser', async () => {
    const clock = { t: 1e12 };
    const { a } = adapterWith({
      '/v1/setup': tokenPair(1),
      '/w3c/openid4vp/v1/initiate': { json: { sessionId: 'w1', requestUri: 'https://credenceid.com/r/1', authorizationRequest: { client_id: 'did:web:credenceid.com:cloudsdk/playground' } } },
      '/dcapi/openid4vp/v1/initiate': { json: { sessionId: 's1', payload: { a: 1 } } }
    }, clock);
    const q = await a.startQr({ flow: 'w3c' });
    const d = await a.startDc({ flow: 'openid4vp' });
    assert.ok(q.walletUri.indexOf('openid4vp://authorize?client_id=did%3Aweb%3Acredenceid.com') === 0);
    assert.notOk((JSON.stringify(q) + JSON.stringify(d)).indexOf(KEY) >= 0, 'key absent');
  });
});

describe('credence response parsing', () => {
  const details = JSON.stringify({
    identity: { 'org.iso.18013.5.1': { given_name: 'Ana', family_name: 'Reyes', birth_date: '2001-02-03', document_number: 'X123', issuing_authority: 'CA DMV' } },
    authentication: { issuerAuth: { signatureValid: true }, deviceAuth: true, issuerTrusted: true }
  });

  it('parses a verified DC API result from the resDetails JSON string', () => {
    const o = parseDcResult(200, { res: true, resDetails: details }, 'w');
    assert.eq(o.status, 'verified');
    assert.eq([o.givenName, o.familyName, o.issuer], ['Ana', 'Reyes', 'CA DMV']);
    assert.eq(o.checks, { signature: true, issuerTrusted: true, notExpired: true });
  });

  it('checks cancelled before anything else', () => {
    assert.eq(parseDcResult(200, { cancelled: true, message: 'User closed the sheet', res: true }).status, 'cancelled');
  });

  it('reports res:false and HTTP 400 as failures with the service reason', () => {
    const a = parseDcResult(200, { res: false, resDetails: 'Device signature invalid' });
    assert.eq([a.status, a.message], ['failed', 'Device signature invalid']);
    assert.eq(parseDcResult(400, { message: 'Validation failed: bad JWE' }).message, 'Validation failed: bad JWE');
  });

  it('treats a false crypto check inside resDetails as a failed signature', () => {
    const bad = JSON.stringify({ identity: { given_name: 'A', family_name: 'B' }, authentication: { signatureValid: false } });
    assert.eq(parseDcResult(200, { res: true, resDetails: bad }).checks.signature, false);
  });

  it('parses the mdoc QR poll: pending, success, denied, timeout, missing', () => {
    assert.eq(parseMdocQrResult(202, { status: 'pending' }).status, 'pending');
    const ok = parseMdocQrResult(200, { success: true, identity: JSON.stringify({ given_name: 'Wei', family_name: 'Zhang' }), error: null });
    assert.eq([ok.status, ok.givenName, ok.familyName], ['verified', 'Wei', 'Zhang']);
    assert.eq(parseMdocQrResult(200, { success: false, identity: null, error: 'User denied consent.' }).status, 'cancelled');
    assert.eq(parseMdocQrResult(200, { success: false, error: 'Session timed out.' }).reason, 'SESSION_TIMEOUT');
    assert.eq(parseMdocQrResult(404, { message: 'Session not found' }).reason, 'SESSION_NOT_FOUND');
  });

  it('parses the W3C poll including verificationDetails and expiry', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const good = { success: true, claims: { given_name: 'Ana', family_name: 'Reyes' }, issuer: 'did:web:dmv.ca.gov', expirationDate: '2030-01-01T00:00:00Z',
      verificationDetails: { vpSignatureValid: true, vcSignatureValid: true, nonceMatches: true, audienceMatches: true, issuerTrusted: true, notExpired: true, credentialTypeMatches: true } };
    const o = parseW3cResult(200, good, 'w', now);
    assert.eq(o.checks, { signature: true, issuerTrusted: true, notExpired: true });
    const untrusted = JSON.parse(JSON.stringify(good)); untrusted.verificationDetails.issuerTrusted = false;
    assert.eq(parseW3cResult(200, untrusted, 'w', now).checks.issuerTrusted, false);
    const expired = Object.assign({}, good, { expirationDate: '2020-01-01T00:00:00Z' });
    assert.eq(parseW3cResult(200, expired, 'w', now).checks.notExpired, false);
    assert.eq(parseW3cResult(202, { error: 'Session is not yet completed. Status: PENDING' }, 'w', now).status, 'pending');
    assert.eq(parseW3cResult(200, { success: false, error: 'Issuer not in trusted list.' }, 'w', now).reason, 'ISSUER_NOT_TRUSTED');
  });
});

describe('identity record and name match', () => {
  it('matches names tolerantly', () => {
    assert.ok(record.nameMatches('Ana Reyes', 'Ana', 'Reyes'));
    assert.ok(record.nameMatches('ana  REYES', 'Ana Maria', 'Reyes Lopez'), 'case + middle names');
    assert.ok(record.nameMatches('José Núñez', 'Jose', 'Nunez'), 'accents');
    assert.ok(record.nameMatches('Zhang Wei', 'Wei', 'Zhang'), 'family-name-first order');
    assert.ok(record.nameMatches('Mary-Jane Watson', 'Mary Jane', 'Watson'), 'hyphen');
  });

  it('rejects different people and single-word names', () => {
    assert.notOk(record.nameMatches('Ana Reyes', 'Alex', 'Sample'));
    assert.notOk(record.nameMatches('Ana', 'Ana', 'Reyes'));
    assert.notOk(record.nameMatches('Ana Reyes', '', ''));
  });

  it('stores only the minimal record, never birth date or document number', () => {
    const r = record.evaluate({
      status: 'verified', wallet: 'w', issuer: 'CA DMV', givenName: 'Ana', familyName: 'Reyes',
      birth_date: '2001-02-03', document_number: 'X1', checks: { signature: true, issuerTrusted: true, notExpired: true }
    }, 'Ana Reyes', 'credence-cloud', 5);
    assert.eq(r.status, 'verified');
    assert.eq(Object.keys(r.record).sort(), ['checks', 'familyName', 'givenName', 'issuer', 'method', 'verified', 'verifiedAt', 'wallet']);
    assert.eq(r.record.method, 'credence-cloud');
  });

  it('fails each security check with its own reason', () => {
    const base = { status: 'verified', givenName: 'Ana', familyName: 'Reyes' };
    const ev = (checks) => record.evaluate(Object.assign({ checks: checks }, base), 'Ana Reyes', 'simulated').reason;
    assert.eq(ev({ signature: false, issuerTrusted: true, notExpired: true }), 'SIGNATURE_INVALID');
    assert.eq(ev({ signature: true, issuerTrusted: false, notExpired: true }), 'ISSUER_NOT_TRUSTED');
    assert.eq(ev({ signature: true, issuerTrusted: true, notExpired: false }), 'DOCUMENT_EXPIRED');
    assert.eq(ev({ signature: true, issuerTrusted: true }), 'DOCUMENT_EXPIRED', 'missing check is not a pass');
  });
});

/* ------------------------------------------------------------ HTTP */

describe('identity over http', () => {
  let server;
  const clock = { t: Date.now() };

  it('boots the server', async () => {
    server = require('../server/index').server;
    if (!server.listening) await new Promise((r) => server.listen(PORT, r));
    identity.setAdapter(createSimulatedAdapter({ now: () => clock.t, qrDelayMs: 3000 }));
    const h = await req('GET', '/api/health');
    assert.eq(h.status, 200);
  });

  it('lets an email-only user message but not post (403)', async () => {
    const token = await signIn('newstudent@usc.edu', 'Ana Reyes');
    const r = await req('POST', '/api/listings', { title: 'IKEA desk', category: 'furniture', price: 30 }, token);
    assert.eq(r.status, 403);
    assert.eq(r.body.code, 'ID_VERIFICATION_REQUIRED');
    const housing = await req('POST', '/api/listings', { title: 'Room near campus', category: 'housing', price: 900 }, token);
    assert.eq(housing.status, 403);
    const t = await req('POST', '/api/threads', { listingId: 'housing-1' }, token);
    assert.eq(t.status, 200, 'messaging allowed');
  });

  it('ignores listings smuggled through the legacy state sync', async () => {
    const token = await signIn('smuggler@usc.edu', 'Sam Smuggler');
    const before = (await req('GET', '/api/listings?limit=1')).body.total;
    await req('POST', '/api/state', { listings: [{ id: 'uX', title: 'sneaky', email: 'smuggler@usc.edu' }] }, token);
    const after = (await req('GET', '/api/listings?limit=1')).body.total;
    assert.eq(after, before);
  });

  it('reports demo mode in status', async () => {
    const token = await signIn('status@usc.edu', 'Stat Us');
    const s = await req('GET', '/api/identity/status', null, token);
    assert.eq([s.body.mode, s.body.demo, s.body.verified], ['simulated', true, false]);
    assert.ok(s.body.scenarios.success);
  });

  it('verifies via the DC API flow, then allows posting with a badge', async () => {
    const token = await signIn('ana.reyes@usc.edu');
    const v = await dcVerify(token, 'success');
    assert.eq(v.body.status, 'verified');
    assert.eq(v.body.identity.method, 'simulated');
    assert.eq(v.body.identity.givenName, undefined, 'names not echoed back');
    const c = await req('POST', '/api/listings', { title: 'Desk chair', category: 'furniture', price: 25 }, token);
    assert.eq(c.status, 201);
    assert.eq(c.body.listing.seller_verified, true);
    const st = await req('GET', '/api/state');
    const mine = st.body.listings.filter((l) => l.id === c.body.listing.id)[0];
    assert.eq(mine.seller_verified, true);
    assert.notOk(JSON.stringify(mine).indexOf('givenName') >= 0, 'identity not public');
  });

  it('refuses the badge when the ID name does not match the account', async () => {
    const token = await signIn('mismatch@usc.edu', 'Maya Patel');
    const v = await dcVerify(token, 'name_mismatch');
    assert.eq([v.body.status, v.body.reason], ['failed', 'NAME_MISMATCH']);
    const s = await req('GET', '/api/identity/status', null, token);
    assert.eq(s.body.verified, false);
  });

  it('reports cancelled and untrusted-issuer outcomes', async () => {
    const token = await signIn('cancel@usc.edu', 'Chris Cancel');
    assert.eq((await dcVerify(token, 'cancelled')).body.status, 'cancelled');
    const u = await dcVerify(token, 'untrusted_issuer');
    assert.eq(u.body.reason, 'ISSUER_NOT_TRUSTED');
  });

  it('polls the QR flow until the wallet responds', async () => {
    const token = await signIn('qr.user@usc.edu');
    const s = await req('POST', '/api/identity/qr/start', { flow: 'w3c', scenario: 'success' }, token);
    assert.ok(/^openid4vp:\/\/authorize\?/.test(s.body.walletUri));
    const p1 = await req('POST', '/api/identity/qr/poll', { sessionId: s.body.sessionId }, token);
    assert.eq(p1.body.status, 'pending');
    clock.t += 5000;
    const p2 = await req('POST', '/api/identity/qr/poll', { sessionId: s.body.sessionId }, token);
    assert.eq(p2.body.status, 'verified');
  });

  it('rejects a verification session that belongs to someone else', async () => {
    const a = await signIn('owner.one@usc.edu');
    const b = await signIn('other.two@usc.edu');
    const s = await req('POST', '/api/identity/dc/start', { scenario: 'success' }, a);
    const v = await req('POST', '/api/identity/dc/verify', { sessionId: s.body.sessionId }, b);
    assert.eq(v.body.reason, 'SESSION_NOT_FOUND');
  });

  it('clears the badge when the account name changes', async () => {
    const token = await signIn('rename.me@usc.edu');
    await dcVerify(token, 'success');
    const r = await req('POST', '/api/identity/name', { name: 'Someone Else' }, token);
    assert.eq(r.body.verified, false);
    const c = await req('POST', '/api/listings', { title: 'Lamp', price: 5 }, token);
    assert.eq(c.status, 403);
  });

  it('keeps the license key out of browser responses with the Credence adapter', async () => {
    const f = mockFetch({
      '/v1/setup': tokenPair(1),
      '/dcapi/openid4vp/v1/initiate': { json: { sessionId: 'cs1', payload: { response_mode: 'dc_api' } } },
      '/dcapi/openid4vp/v1/validate': { json: { res: true, resDetails: JSON.stringify({ identity: { given_name: 'Kai', family_name: 'Lee' }, authentication: {} }) } }
    });
    identity.setAdapter(createCredenceAdapter({ baseUrl: 'https://credenceid.com/cloudsdk/playground', licenseKey: KEY, profileId: PROFILE, origin: ORIGIN, fetch: f }));
    const token = await signIn('kai.lee@usc.edu');
    const s = await req('POST', '/api/identity/dc/start', { flow: 'openid4vp' }, token);
    assert.eq([s.body.protocol, s.body.demo], ['openid4vp', false]);
    const v = await req('POST', '/api/identity/dc/verify', { sessionId: 'cs1', data: 'jwe' }, token);
    assert.eq(v.body.identity.method, 'credence-cloud');
    assert.notOk((s.raw + v.raw).indexOf(KEY) >= 0);
    assert.eq(f.calls[f.calls.length - 1].body, { sessionId: 'cs1', data: 'jwe' });
  });

  it('maps Credence errors to a 502 with the error code', async () => {
    const f = mockFetch({ '/v1/setup': { status: 403, json: { code: 'DOMAIN_MISMATCH' } } });
    identity.setAdapter(createCredenceAdapter({ baseUrl: 'https://credenceid.com/cloudsdk/playground', licenseKey: KEY, profileId: PROFILE, origin: ORIGIN, fetch: f }));
    const token = await signIn('err.user@usc.edu');
    const s = await req('POST', '/api/identity/qr/start', { flow: 'mdoc' }, token);
    assert.eq([s.status, s.body.code], [502, 'DOMAIN_MISMATCH']);
    identity.setAdapter(createSimulatedAdapter());
  });

  it('returns the demo code in development only', async () => {
    const dev = await req('POST', '/api/auth/request', { email: 'devmode@usc.edu' });
    assert.eq(dev.body.demoCode, '482913');
    cfg.IS_PRODUCTION = true;
    try {
      const prod = await req('POST', '/api/auth/request', { email: 'prodmode@usc.edu' });
      assert.eq(prod.status, 200);
      assert.notOk('demoCode' in prod.body, 'no demoCode field');
      assert.notOk(prod.raw.indexOf('482913') >= 0);
      const conf = await req('GET', '/api/auth/config');
      assert.eq(conf.body.demo_code_enabled, false);
      const v = await req('POST', '/api/auth/verify', { email: 'prodmode@usc.edu', code: '482913' });
      assert.eq(v.status, 400, 'fixed demo code rejected in production');
    } finally { cfg.IS_PRODUCTION = false; }
  });

  it('blocks edits to a listing once the badge is cleared, but still allows marking sold', async () => {
    const token = await signIn('editor.one@usc.edu', 'Edie Tor');
    assert.eq((await dcVerify(token, 'success')).body.status, 'verified');
    const c = await req('POST', '/api/listings', { title: 'Lamp', category: 'furniture', price: 10 }, token);
    const id = c.body.listing.id;
    await req('POST', '/api/identity/name', { name: 'Edie Torres' }, token);
    const edit = await req('PATCH', '/api/listings/' + id, { category: 'housing', title: 'Room' }, token);
    assert.eq(edit.status, 403);
    const sold = await req('PATCH', '/api/listings/' + id, { sold: true }, token);
    assert.eq(sold.status, 200);
  });

  it('does not let a non-member overwrite a conversation through the legacy state sync', async () => {
    const a = await signIn('thread.a@usc.edu', 'Thea Aye');
    const b = await signIn('thread.b@usc.edu', 'Bo Bee');
    const t = await req('POST', '/api/threads', { listingId: 'housing-1' }, a);
    await req('POST', '/api/threads/' + t.body.thread.id + '/messages', { text: 'private note' }, a);
    await req('POST', '/api/state', { threads: [{ id: t.body.thread.id, messages: [{ from: 'x', text: 'forged' }] }] }, b);
    const mine = await req('GET', '/api/threads', null, a);
    const got = mine.body.threads.filter((x) => x.id === t.body.thread.id)[0];
    assert.ok(got.messages.some((m) => m.text === 'private note'));
    assert.notOk(got.messages.some((m) => m.text === 'forged'));
  });

  it('streams new messages only to members of the conversation', async () => {
    const a = await signIn('stream.a@usc.edu', 'Stella Aye');
    const t = await req('POST', '/api/threads', { listingId: 'housing-1' }, a);
    let seen = '';
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/stream' }, (res) => {
        res.on('data', (c) => { seen += c; });
        resolve();
      });
    });
    await req('POST', '/api/threads/' + t.body.thread.id + '/messages', { text: 'members only' }, a);
    await new Promise((r) => setTimeout(r, 100));
    assert.notOk(/members only/.test(seen));
  });

  it('shuts down', () => {
    server.close();
    assert.ok(true);
  });
});
