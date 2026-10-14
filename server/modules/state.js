/* Profile + legacy whole-state sync used by the bundled single-file client.
   Listings are deliberately NOT accepted here: they change only through
   /api/listings, where ownership and the digital-ID requirement are enforced. */
const http = require('../lib/http');
const store = require('../lib/store');
const { BLANK_PROFILE } = require('../data');
const identity = require('./identity');

async function getProfile(ctx) {
  return http.ok(ctx.res, { profile: store.db.profiles[ctx.user.email] || null, blank: BLANK_PROFILE });
}

async function putProfile(ctx) {
  const b = await http.readBody(ctx.req);
  store.db.profiles[ctx.user.email] = Object.assign({}, BLANK_PROFILE, store.db.profiles[ctx.user.email] || {}, b.profile || b);
  store.save();
  return http.ok(ctx.res, { profile: store.db.profiles[ctx.user.email] });
}

async function getState(ctx) {
  const me = ctx.user;
  return http.ok(ctx.res, {
    listings: store.db.listings.map(identity.publicListing),
    favorites: me ? (store.db.favorites[me.email] || []) : [],
    threads: me ? store.db.threads.filter((t) => (t.members || []).indexOf(me.email) >= 0).map((t) => identity.publicThread(t, me.email)) : [],
    user: me || null,
    profile: me ? (store.db.profiles[me.email] || null) : null,
    behavior: me ? (store.db.behavior[me.email] || null) : null
  });
}

async function postState(ctx) {
  const b = await http.readBody(ctx.req);
  const me = ctx.user;
  if (Array.isArray(b.favorites)) store.db.favorites[me.email] = b.favorites;
  if (b.profile) store.db.profiles[me.email] = b.profile;
  if (b.behavior) store.db.behavior[me.email] = b.behavior;
  if (Array.isArray(b.threads)) {
    b.threads.forEach((t) => {
      const existing = store.db.threads.filter((x) => x.id === t.id)[0];
      if (existing) {
        if ((existing.members || []).indexOf(me.email) >= 0 && Array.isArray(t.messages)) existing.messages = t.messages;
      } else store.db.threads.unshift(Object.assign({}, t, { members: [me.email, t.email] }));
    });
  }
  store.save();
  ctx.broadcast('state', {}, ctx.token);
  return http.ok(ctx.res, { ok: true });
}

/* Retained for backwards compatibility with the shipped client. The event log
   is now the authoritative behavioural record. */
async function behavior(ctx) {
  const b = await http.readBody(ctx.req);
  const beh = store.db.behavior[ctx.user.email] || { cats: {}, hoods: {}, prices: [], skips: [] };
  const l = store.db.listings.filter((x) => x.id === b.listingId)[0];
  if (l) {
    if (b.kind === 'skip') beh.skips = (beh.skips || []).concat([l.id]);
    else {
      const w = b.kind === 'save' ? 3 : 1;
      beh.cats[l.category] = (beh.cats[l.category] || 0) + w;
      const h = require('../data').HOUSE[l.id];
      if (h) beh.hoods[h.hood] = (beh.hoods[h.hood] || 0) + w;
      beh.prices = (beh.prices || []).concat([Number(l.price) || 0]).slice(-20);
    }
  }
  store.db.behavior[ctx.user.email] = beh;
  store.save();
  return http.ok(ctx.res, { behavior: beh });
}

module.exports = {
  routes: [
    { method: 'GET', path: '/api/profile', handler: getProfile, opts: { auth: true } },
    { method: 'PUT', path: '/api/profile', handler: putProfile, opts: { auth: true } },
    { method: 'POST', path: '/api/profile', handler: putProfile, opts: { auth: true } },
    { method: 'GET', path: '/api/state', handler: getState },
    { method: 'POST', path: '/api/state', handler: postState, opts: { auth: true } },
    { method: 'POST', path: '/api/behavior', handler: behavior, opts: { auth: true } }
  ]
};
