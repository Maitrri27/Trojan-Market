/* Listings CRUD + search, with cursor pagination and outcome events. */
const http = require('../lib/http');
const store = require('../lib/store');
const events = require('../lib/events');
const cfg = require('../lib/config');
const { CATKW } = require('../data');
const identity = require('./identity');

function search(params) {
  const cat = params.get('category');
  const q = (params.get('q') || '').toLowerCase().trim();
  const freeOnly = params.get('free') === '1';
  const sort = params.get('sort') || 'new';
  let out = store.db.listings.filter((l) => {
    if (l.removed) return false;
    if (cat && cat !== 'all' && l.category !== cat && !(cat === 'free' && (l.free || Number(l.price) === 0))) return false;
    if (freeOnly && !(l.free || Number(l.price) === 0)) return false;
    if (q && !((l.title + ' ' + l.description + ' ' + l.location + ' ' + l.category).toLowerCase().includes(q))) return false;
    return true;
  });
  if (sort === 'low') out.sort((a, b) => a.price - b.price);
  else if (sort === 'high') out.sort((a, b) => b.price - a.price);
  else out.sort((a, b) => (a.days || 0) - (b.days || 0));
  return out;
}

async function list(ctx) {
  const s = ctx.url.searchParams;
  const rows = search(s);
  const page = http.paginate(rows, s.get('cursor'), s.get('limit') || 24);
  if (s.get('q')) {
    events.emit('search', {
      user_id: ctx.analyticsId, session_id: s.get('session_id'),
      query_text: s.get('q'), surface: 'search',
      metadata: { result_count: rows.length, category: s.get('category') || null }
    }, { userId: ctx.analyticsId });
  }
  return http.ok(ctx.res, { listings: page.items.map(identity.publicListing), next_cursor: page.next_cursor, total: page.total });
}

async function create(ctx) {
  if (!identity.requireVerified(ctx)) return;
  const b = await http.readBody(ctx.req);
  const errs = http.validate(b, {
    title: { type: 'string', required: true, max: 140 },
    category: { type: 'string', max: 40 },
    description: { type: 'string', max: 4000 },
    location: { type: 'string', max: 120 }
  });
  if (errs) return http.badRequest(ctx.res, 'Invalid listing.', errs);

  const item = {
    id: 'u' + Date.now() + Math.random().toString(36).slice(2, 6),
    title: b.title, category: b.category || 'other',
    price: b.free ? 0 : Number(b.price) || 0, free: !!b.free,
    kw: b.kw || CATKW[b.category] || 'campus',
    location: b.location || 'USC area', condition: b.condition || '—',
    description: b.description || '', photo: b.photo || '',
    seller: store.db.users[ctx.user.email].name, email: ctx.user.email,
    days: 0, views: 0, seed: Date.now() % 9999, created_at: Date.now()
  };
  store.db.listings.unshift(item);
  store.save();
  ctx.broadcast('listing:new', item, ctx.token);
  return http.created(ctx.res, { listing: identity.publicListing(item) });
}

function find(id) { return store.db.listings.filter((x) => x.id === id)[0]; }

async function detail(ctx) {
  const l = find(ctx.params[0]);
  if (!l) return http.notFound(ctx.res, 'Listing not found.');
  l.views = (l.views || 0) + 1;
  store.save();
  events.emit('detail_view', {
    user_id: ctx.analyticsId, listing_id: l.id, surface: 'detail',
    session_id: ctx.url.searchParams.get('session_id')
  }, { userId: ctx.analyticsId });
  return http.ok(ctx.res, { listing: identity.publicListing(l) });
}

async function update(ctx) {
  const l = find(ctx.params[0]);
  if (!l) return http.notFound(ctx.res, 'Listing not found.');
  if (l.email !== ctx.user.email) return http.forbidden(ctx.res, 'You can only change your own listings.');
  const b = await http.readBody(ctx.req);
  if (Object.keys(b).some((k) => k !== 'sold') && !identity.requireVerified(ctx)) return;
  const wasSold = !!l.sold;
  ['title', 'category', 'price', 'free', 'location', 'condition', 'description', 'photo', 'sold'].forEach((k) => {
    if (k in b) l[k] = b[k];
  });
  if (l.free) l.price = 0;
  store.save();
  if (!wasSold && l.sold) {
    events.emit(l.category === 'housing' ? 'marked_rented' : 'marked_sold',
      { user_id: ctx.analyticsId, listing_id: l.id, surface: 'detail' }, { userId: ctx.analyticsId });
  }
  ctx.broadcast('listing:update', l, ctx.token);
  return http.ok(ctx.res, { listing: identity.publicListing(l) });
}

async function remove(ctx) {
  const l = find(ctx.params[0]);
  if (!l) return http.notFound(ctx.res, 'Listing not found.');
  if (l.email !== ctx.user.email) return http.forbidden(ctx.res, 'You can only remove your own listings.');
  store.db.listings = store.db.listings.filter((x) => x.id !== l.id);
  store.save();
  events.emit('listing_removed', { user_id: ctx.analyticsId, listing_id: l.id }, { userId: ctx.analyticsId });
  ctx.broadcast('listing:delete', { id: l.id }, ctx.token);
  return http.ok(ctx.res, { ok: true });
}

module.exports = {
  search, find,
  routes: [
    { method: 'GET', path: '/api/listings', handler: list },
    { method: 'POST', path: '/api/listings', handler: create, opts: { auth: true } },
    { method: 'GET', path: /^\/api\/listings\/([\w-]+)$/, handler: detail },
    { method: 'PATCH', path: /^\/api\/listings\/([\w-]+)$/, handler: update, opts: { auth: true } },
    { method: 'DELETE', path: /^\/api\/listings\/([\w-]+)$/, handler: remove, opts: { auth: true } }
  ]
};
