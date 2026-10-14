/* Conversations, messages and offers. Message BODIES are never logged as
   analytics — only that a message happened. See docs/PRIVACY.md. */
const http = require('../lib/http');
const store = require('../lib/store');
const events = require('../lib/events');
const listings = require('./listings');
const identity = require('./identity');

async function threads(ctx) {
  return http.ok(ctx.res, { threads: store.db.threads.filter((t) => (t.members || []).indexOf(ctx.user.email) >= 0).map((t) => identity.publicThread(t, ctx.user.email)) });
}

async function start(ctx) {
  const b = await http.readBody(ctx.req);
  const l = listings.find(b.listingId);
  if (!l) return http.notFound(ctx.res, 'Listing not found.');
  let t = store.db.threads.filter((x) => x.listingId === l.id && (x.members || []).indexOf(ctx.user.email) >= 0)[0];
  if (!t) {
    t = {
      id: 't' + Date.now() + Math.random().toString(36).slice(2, 5),
      listingId: l.id, listingTitle: l.title,
      members: [ctx.user.email, l.email], name: l.seller, email: l.email,
      created_at: Date.now(),
      messages: [{ from: l.email, text: 'Hi! Thanks for reaching out about "' + l.title + '".', at: Date.now() }]
    };
    store.db.threads.unshift(t);
    store.save();
    events.emit('message_started', { user_id: ctx.analyticsId, listing_id: l.id, surface: 'detail' }, { userId: ctx.analyticsId });
  }
  return http.ok(ctx.res, { thread: t });
}

async function send(ctx) {
  const t = store.db.threads.filter((x) => x.id === ctx.params[0])[0];
  if (!t) return http.notFound(ctx.res, 'Conversation not found.');
  if ((t.members || []).indexOf(ctx.user.email) < 0) return http.forbidden(ctx.res, 'Not a member of this conversation.');
  const b = await http.readBody(ctx.req);
  const text = String(b.text || '').slice(0, 2000);
  if (!text.trim()) return http.badRequest(ctx.res, 'Message text is required.');
  const message = { from: ctx.user.email, text: text, at: Date.now() };
  t.messages.push(message);
  store.save();

  const isFirstFromMe = t.messages.filter((m) => m.from === ctx.user.email).length === 1;
  events.emit(isFirstFromMe ? 'message_sent' : 'reply_received', {
    user_id: ctx.analyticsId, listing_id: t.listingId, surface: 'messages',
    metadata: { conversation_depth: t.messages.length }   /* count, never content */
  }, { userId: ctx.analyticsId });

  ctx.broadcast('message:new', { threadId: t.id, message: message }, ctx.token, t.members);
  return http.created(ctx.res, { message: message });
}

async function offer(ctx) {
  const b = await http.readBody(ctx.req);
  const l = listings.find(b.listingId);
  if (!l) return http.notFound(ctx.res, 'Listing not found.');
  const o = {
    offer_id: 'o' + Date.now(), listing_id: l.id, from: ctx.user.email,
    amount: Number(b.amount) || 0, status: 'sent', created_at: Date.now()
  };
  store.db.offers.push(o); store.save();
  events.emit('offer_sent', { user_id: ctx.analyticsId, listing_id: l.id, surface: 'detail', metadata: { amount: o.amount } }, { userId: ctx.analyticsId });
  return http.created(ctx.res, { offer: o });
}

async function offerRespond(ctx) {
  const o = (store.db.offers || []).filter((x) => x.offer_id === ctx.params[0])[0];
  if (!o) return http.notFound(ctx.res, 'Offer not found.');
  const l = listings.find(o.listing_id);
  if (!l || l.email !== ctx.user.email) return http.forbidden(ctx.res, 'Only the seller can respond.');
  const b = await http.readBody(ctx.req);
  o.status = b.accept ? 'accepted' : 'declined';
  o.responded_at = Date.now();
  if (b.accept) {
    store.db.transactions.push({ transaction_id: 'tx' + Date.now(), listing_id: l.id, buyer: o.from, seller: l.email, amount: o.amount, at: Date.now() });
    events.emit('offer_accepted', { user_id: ctx.analyticsId, listing_id: l.id, surface: 'messages' }, { userId: ctx.analyticsId });
    events.emit('transaction_confirmed', { user_id: ctx.analyticsId, listing_id: l.id, surface: 'messages', metadata: { amount: o.amount } }, { userId: ctx.analyticsId });
  }
  store.save();
  return http.ok(ctx.res, { offer: o });
}

module.exports = {
  routes: [
    { method: 'GET', path: '/api/threads', handler: threads, opts: { auth: true } },
    { method: 'POST', path: '/api/threads', handler: start, opts: { auth: true } },
    { method: 'POST', path: /^\/api\/threads\/([\w-]+)\/messages$/, handler: send, opts: { auth: true } },
    { method: 'POST', path: '/api/offers', handler: offer, opts: { auth: true } },
    { method: 'POST', path: /^\/api\/offers\/([\w-]+)\/respond$/, handler: offerRespond, opts: { auth: true } }
  ]
};
