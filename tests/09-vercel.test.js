/* Vercel deployment: handler export, storage paths, demo flags, signed sessions. */
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let port = 0;
let server = null;

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/* Load config in a child process with a controlled environment. */
function configWith(env) {
  const clean = {};
  Object.keys(process.env).forEach((k) => {
    if (!/^(TM_|VERCEL|NODE_ENV)/.test(k)) clean[k] = process.env[k];
  });
  const out = execFileSync(process.execPath, ['-e',
    'const c = require("./server/lib/config"); process.stdout.write(JSON.stringify({ db: c.DB_FILE, ev: c.EVENT_LOG, data: c.DATA_DIR, reg: c.REGISTRY_FILE, demo: c.DEMO_AUTH_CODE, explicit: c.DEMO_CODE_EXPLICIT, sim: c.SIMULATED_ID_ENABLED, stateless: c.STATELESS_SESSIONS, vercel: c.IS_VERCEL }))'
  ], { cwd: ROOT, env: Object.assign(clean, env) });
  return JSON.parse(out.toString());
}

/* Forget the token and the user on this instance, as a fresh instance would. */
function forget(store, token, email) {
  delete store.db.sessions[token];
  delete store.db.users[email];
}

describe('vercel deployment', () => {
  const tokens = require('../server/lib/token');

  it('exports a request handler and an init promise', async () => {
    const app = require('../server/app');
    assert.eq(typeof app.handle, 'function');
    assert.eq(typeof app.handleServerless, 'function');
    assert.ok(app.ready && typeof app.ready.then === 'function', 'ready is a promise');
    const entry = require('../api/index');
    assert.eq(typeof entry, 'function');
    assert.eq(typeof require('../server/index').handle, 'function');
  });

  it('serves requests through the serverless wrapper', async () => {
    const app = require('../server/app');
    server = http.createServer(app.handleServerless);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const h = await req('GET', '/api/health');
    assert.eq([h.status, h.body.ok, h.body.realtime], [200, true, true]);
  });

  it('restores the original path from the rewrite', () => {
    const { originalUrl } = require('../api/index');
    assert.eq(originalUrl('/api/index?__path=listings%2Fabc&q=1'), '/api/listings/abc?q=1');
    assert.eq(originalUrl('/api/listings/abc?q=1&__path=listings%2Fabc'), '/api/listings/abc?q=1');
    assert.eq(originalUrl('/api/health'), '/api/health');
  });

  it('keeps the repository paths when not on Vercel', () => {
    const c = configWith({});
    assert.eq(c.vercel, false);
    assert.eq(c.db, path.join(ROOT, 'server', 'db.json'));
    assert.eq(c.ev, path.join(ROOT, 'server', 'data', 'events.jsonl'));
    assert.eq([c.demo, c.sim, c.stateless], ['482913', true, false]);
  });

  it('moves runtime files to the temp dir on Vercel', () => {
    const c = configWith({ VERCEL: '1' });
    const base = path.join(os.tmpdir(), 'trojan-market');
    assert.eq(c.db, path.join(base, 'db.json'));
    assert.eq(c.ev, path.join(base, 'data', 'events.jsonl'));
    assert.eq(c.data, path.join(base, 'data'));
    assert.eq(c.reg, path.join(base, 'registry.json'));
    assert.eq(c.stateless, true);
  });

  it('lets explicit storage paths win on Vercel', () => {
    const c = configWith({ VERCEL: '1', TM_DB_FILE: path.join(os.tmpdir(), 'custom.json') });
    assert.eq(c.db, path.join(os.tmpdir(), 'custom.json'));
  });

  it('controls demo flags on Vercel by TM_DEMO_CODE and TM_SIMULATED_ID only', () => {
    const off = configWith({ VERCEL: '1', NODE_ENV: 'production' });
    assert.eq([off.demo, off.explicit, off.sim], ['', false, false]);
    const on = configWith({ VERCEL: '1', NODE_ENV: 'production', TM_DEMO_CODE: '482913', TM_SIMULATED_ID: 'true' });
    assert.eq([on.demo, on.explicit, on.sim], ['482913', true, true]);
    const prod = configWith({ NODE_ENV: 'production', TM_DEMO_CODE: '482913' });
    assert.eq(prod.explicit, false, 'outside Vercel, production still ignores the demo code');
  });

  it('signs and verifies session tokens', () => {
    const t = tokens.sign({ e: 'a@usc.edu', n: 'A B', x: Date.now() + 60000, id: null }, 'k1');
    assert.ok(tokens.isSigned(t));
    assert.eq(tokens.verify(t, 'k1').e, 'a@usc.edu');
  });

  it('rejects tampered, re-keyed, malformed and expired tokens', () => {
    const t = tokens.sign({ e: 'a@usc.edu', n: 'A B', x: Date.now() + 60000, id: null }, 'k1');
    const parts = t.split('.');
    const forged = Buffer.from(JSON.stringify({ e: 'a@usc.edu', n: 'A B', x: Date.now() + 60000, id: { verified: true } })).toString('base64url');
    assert.eq(tokens.verify(parts[0] + '.' + forged + '.' + parts[2], 'k1'), null, 'payload swap');
    assert.eq(tokens.verify(parts[0] + '.' + parts[1] + '.' + parts[2].slice(1) + 'A', 'k1'), null, 'signature edit');
    assert.eq(tokens.verify(t, 'k2'), null, 'wrong key');
    assert.eq(tokens.verify('nonsense', 'k1'), null, 'malformed');
    assert.eq(tokens.verify(t, 'k1', Date.now() + 120000), null, 'expired');
    const expired = tokens.sign({ e: 'a@usc.edu', x: Date.now() - 1 }, 'k1');
    assert.eq(tokens.verify(expired, 'k1'), null);
  });

  it('never signs with a key derivable from public deployment metadata', () => {
    const { execFileSync } = require('child_process');
    const clean = {};
    Object.keys(process.env).forEach((k) => { if (!/^(TM_|VERCEL|NODE_ENV)/.test(k)) clean[k] = process.env[k]; });
    const code = 'const t=require("./server/lib/token");const c=require("crypto");' +
      'const guess=c.createHash("sha256").update("tm-session|dpl_1").digest("hex");' +
      'const forged=t.sign({e:"a@usc.edu",x:Date.now()+60000},guess);' +
      'process.stdout.write(String(t.verify(forged)))';
    const out = execFileSync(process.execPath, ['-e', code], { cwd: ROOT, env: Object.assign(clean, { VERCEL: '1', VERCEL_DEPLOYMENT_ID: 'dpl_1' }), stdio: ['ignore', 'pipe', 'ignore'] });
    assert.eq(out.toString(), 'null');
  });

  it('keeps purpose keys separate', () => {
    const sealed = tokens.seal({ e: 'a@usc.edu', x: Date.now() + 60000 }, tokens.keyFor('identity-session'));
    assert.eq(tokens.verify(sealed), null, 'an identity session is not a sign-in token');
  });

  it('carries sign-in and the ID badge across instances with stateless sessions', async () => {
    const cfg = require('../server/lib/config');
    const store = require('../server/lib/store');
    const identity = require('../server/modules/identity');
    const { createSimulatedAdapter } = require('../server/modules/identity/simulated');
    const email = 'stateless.user@usc.edu';
    cfg.STATELESS_SESSIONS = true;
    identity.setAdapter(identity.selectAdapter(cfg));
    try {
      await req('POST', '/api/auth/request', { email: email });
      const signedIn = (await req('POST', '/api/auth/verify', { email: email, code: '482913' })).body.token;
      assert.ok(tokens.isSigned(signedIn), 'signed token issued');

      forget(store, signedIn, email);
      assert.eq((await req('GET', '/api/auth/me', null, signedIn)).body.user.email, email);

      const named = await req('POST', '/api/identity/name', { name: 'Stella Less' }, signedIn);
      assert.ok(named.body.token, 'name change re-issues the token');
      const start = await req('POST', '/api/identity/dc/start', { flow: 'openid4vp', scenario: 'success' }, named.body.token);

      forget(store, named.body.token, email);
      identity.setAdapter(identity.selectAdapter(cfg));
      const done = await req('POST', '/api/identity/dc/verify', { sessionId: start.body.sessionId, data: null }, named.body.token);
      assert.eq(done.body.status, 'verified', 'verification finishes on a fresh instance');
      const verified = done.body.token;
      assert.ok(verified, 'verification re-issues the token');

      forget(store, named.body.token, email);
      const denied = await req('POST', '/api/listings', { title: 'Desk lamp', category: 'furniture', price: 10 }, named.body.token);
      assert.eq(denied.status, 403, 'a token without the badge cannot post');

      forget(store, verified, email);
      const posted = await req('POST', '/api/listings', { title: 'Desk lamp', category: 'furniture', price: 10 }, verified);
      assert.eq(posted.status, 201, 'the badge travels in the signed token');

      await req('POST', '/api/auth/signout', {}, verified);
      assert.eq((await req('GET', '/api/auth/me', null, verified)).status, 401, 'signed-out token is refused here');

      const parts = verified.split('.');
      assert.eq((await req('GET', '/api/auth/me', null, parts[0] + '.' + parts[1] + '.x' + parts[2].slice(1))).status, 401);
    } finally {
      cfg.STATELESS_SESSIONS = false;
      identity.setAdapter(createSimulatedAdapter());
      server.close();
    }
  });
});
