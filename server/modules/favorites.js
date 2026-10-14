const http = require('../lib/http');
const store = require('../lib/store');
const events = require('../lib/events');

async function get(ctx) {
  return http.ok(ctx.res, { favorites: store.db.favorites[ctx.user.email] || [] });
}

async function toggle(ctx) {
  const b = await http.readBody(ctx.req);
  if (!b.listingId) return http.badRequest(ctx.res, 'listingId is required.');
  const list = store.db.favorites[ctx.user.email] || [];
  const has = list.indexOf(b.listingId) >= 0;
  store.db.favorites[ctx.user.email] = has ? list.filter((x) => x !== b.listingId) : list.concat([b.listingId]);
  store.save();
  events.emit(has ? 'unsave' : 'save', {
    user_id: ctx.analyticsId, listing_id: b.listingId,
    surface: b.surface || 'detail', session_id: b.session_id, rank_position: b.rank_position
  }, { userId: ctx.analyticsId });
  return http.ok(ctx.res, { favorites: store.db.favorites[ctx.user.email], saved: !has });
}

module.exports = {
  routes: [
    { method: 'GET', path: '/api/favorites', handler: get, opts: { auth: true } },
    { method: 'POST', path: '/api/favorites', handler: toggle, opts: { auth: true } }
  ]
};
