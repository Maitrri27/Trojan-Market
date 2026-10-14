/* End-to-end HTTP: auth, listings, events, recommendations, admin gating. */
const http = require('http');

/* Environment isolation lives in tests/run.js — it must happen before any
   server module loads its config. */
const PORT = Number(process.env.PORT || 4123);

let server;

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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function signIn(email) {
  await req('POST', '/api/auth/request', { email: email });
  const v = await req('POST', '/api/auth/verify', { email: email, code: '482913' });
  return v.body.token;
}

/* Listings need the digital-ID badge; earn it through the simulated adapter. */
async function signInVerified(email, name) {
  const token = await signIn(email);
  await req('POST', '/api/identity/name', { name: name || 'Test Seller' }, token);
  const s = await req('POST', '/api/identity/dc/start', { flow: 'openid4vp', scenario: 'success' }, token);
  await req('POST', '/api/identity/dc/verify', { sessionId: s.body.sessionId, data: null }, token);
  return token;
}

describe('http api', () => {
  it('boots the server', async () => {
    server = require('../server/index').server;
    await new Promise((r) => setTimeout(r, 350));
    const h = await req('GET', '/api/health');
    assert.eq(h.status, 200);
    assert.eq(h.body.ok, true);
    assert.eq(h.body.recommendation_mode, 'heuristic');
  });

  it('rejects a non-USC email', async () => {
    const r = await req('POST', '/api/auth/request', { email: 'someone@gmail.com' });
    assert.eq(r.status, 400);
  });

  it('signs in with a usc.edu address', async () => {
    const token = await signIn('tester@usc.edu');
    assert.ok(token && token.length > 10);
  });

  it('serves recommendations without authentication', async () => {
    const r = await req('GET', '/api/recommendations?limit=5&surface=foryou');
    assert.eq(r.status, 200);
    assert.eq(r.body.recommendations.length, 5);
    assert.eq(r.body.meta.source, 'heuristic');
  });

  it('hides internal meta from non-admins', async () => {
    const r = await req('GET', '/api/recommendations?limit=2');
    assert.eq(r.body.meta.candidate_sources, undefined, 'internals withheld');
    assert.ok(r.body.meta.source, 'public fields present');
  });

  it('accepts an event batch', async () => {
    const r = await req('POST', '/api/events', {
      events: [
        { event_type: 'impression', listing_id: 'housing-1', surface: 'home', rank_position: 0, session_id: 's_api' },
        { event_type: 'click', listing_id: 'housing-1', surface: 'home', rank_position: 0, session_id: 's_api' }
      ]
    });
    assert.eq(r.status, 202);
    assert.eq(r.body.accepted, 2);
  });

  it('reports partial success on a mixed batch', async () => {
    const r = await req('POST', '/api/events', { events: [{ event_type: 'click' }, { nope: true }] });
    assert.eq(r.status, 207);
    assert.eq(r.body.accepted, 1);
    assert.eq(r.body.rejected, 1);
  });

  it('publishes the event schema', async () => {
    const r = await req('GET', '/api/events/schema');
    assert.eq(r.status, 200);
    assert.ok(r.body.event_types.discovery.indexOf('impression') >= 0);
  });

  it('requires auth to post a listing', async () => {
    const r = await req('POST', '/api/listings', { title: 'Test' });
    assert.eq(r.status, 401);
  });

  it('creates and fetches a listing', async () => {
    const token = await signInVerified('seller@usc.edu');
    const c = await req('POST', '/api/listings', { title: 'Test desk', category: 'furniture', price: 40 }, token);
    assert.eq(c.status, 201);
    const g = await req('GET', '/api/listings/' + c.body.listing.id);
    assert.eq(g.status, 200);
    assert.eq(g.body.listing.title, 'Test desk');
  });

  it('validates listing input', async () => {
    const token = await signInVerified('seller2@usc.edu');
    const r = await req('POST', '/api/listings', { title: '' }, token);
    assert.eq(r.status, 400);
  });

  it('blocks editing someone else\'s listing', async () => {
    const a = await signInVerified('owner@usc.edu');
    const created = await req('POST', '/api/listings', { title: 'Mine', price: 10 }, a);
    const b = await signIn('intruder@usc.edu');
    const r = await req('PATCH', '/api/listings/' + created.body.listing.id, { price: 1 }, b);
    assert.eq(r.status, 403);
  });

  it('paginates listings with a cursor', async () => {
    const r = await req('GET', '/api/listings?limit=5');
    assert.eq(r.body.listings.length, 5);
    assert.ok(r.body.next_cursor, 'cursor issued');
    const r2 = await req('GET', '/api/listings?limit=5&cursor=' + r.body.next_cursor);
    assert.eq(r2.body.listings.length, 5);
    assert.ok(r2.body.listings[0].id !== r.body.listings[0].id, 'second page differs');
  });

  it('filters housing by every supported facet', async () => {
    const r = await req('GET', '/api/housing?rentMin=0&rentMax=1200&beds=1&furnishing=furnished');
    assert.eq(r.status, 200);
    r.body.homes.forEach((h) => {
      assert.ok(h.detail.rent <= 1200, 'rent filter honoured');
      assert.ok(h.detail.furnished, 'furnishing filter honoured');
    });
  });

  it('returns a House Match with explanations', async () => {
    const r = await req('GET', '/api/listings/housing-1/match');
    assert.eq(r.status, 200);
    assert.ok(r.body.match >= 0 && r.body.match <= 100);
    assert.eq(r.body.checks.length, 7);
    assert.eq(r.body.scoring.source, 'heuristic');
  });

  it('states that roommate ranking uses no model', async () => {
    const r = await req('GET', '/api/roommates');
    assert.eq(r.status, 200);
    assert.eq(r.body.scoring.model, null);
    assert.ok(r.body.roommates.length > 0);
  });

  it('reports honest pipeline readiness counters', async () => {
    const r = await req('GET', '/api/roommates/outcomes/stats');
    assert.eq(r.body.ready_to_train, false);
    assert.eq(r.body.active_model, null);
    const f = await req('GET', '/api/moderation/fraud/stats');
    assert.eq(f.body.active_classifier, null);
  });

  it('exposes recommendation status with no active model', async () => {
    const r = await req('GET', '/api/recommendations/status');
    assert.eq(r.status, 200);
    assert.eq(r.body.mode, 'heuristic');
    assert.eq(r.body.heuristic.always_available, true);
    assert.eq(r.body.models.length, 0);
  });

  it('closes admin endpoints to normal users', async () => {
    const token = await signIn('normal@usc.edu');
    const r = await req('GET', '/api/admin/overview', null, token);
    assert.eq(r.status, 403);
  });

  it('opens the admin dashboard to an admin', async () => {
    const token = await signIn('admin@usc.edu');
    const r = await req('GET', '/api/admin/overview', null, token);
    assert.eq(r.status, 200);
    assert.ok(r.body.events.total >= 0);
    assert.eq(r.body.recommendation_mode, 'heuristic');
    assert.eq(r.body.ml.dataset_readiness.ready_to_train, false);
  });

  it('refuses to activate a model that fails the gates', async () => {
    const token = await signIn('admin@usc.edu');
    const r = await req('POST', '/api/ml/models/promote', { model_id: 'nonexistent', status: 'active' }, token);
    assert.eq(r.status, 400);
  });

  it('records a housing pairwise preference', async () => {
    const token = await signIn('prefs@usc.edu');
    const n = await req('GET', '/api/housing/pairwise/next', null, token);
    assert.eq(n.status, 200);
    assert.ok(n.body.pair.option_a.listing_id);
    const a = await req('POST', '/api/housing/pairwise', {
      option_a: n.body.pair.option_a.listing_id,
      option_b: n.body.pair.option_b.listing_id,
      selected_option: 'a'
    }, token);
    assert.eq(a.status, 201);
    const s = await req('GET', '/api/housing/pairwise/stats');
    assert.ok(s.body.total_pairs >= 1);
    assert.eq(s.body.ready_to_train, false);
  });

  it('404s an unknown endpoint', async () => {
    const r = await req('GET', '/api/nope');
    assert.eq(r.status, 404);
  });

  it('shuts down', () => {
    if (server) server.close();
    assert.ok(true);
  });
});
