# Data Privacy

## Never logged

* passwords (none exist — auth is email code only)
* session tokens
* message bodies (only *that* a message happened, and conversation depth)
* email addresses in the behavioural log
* free-text listing descriptions in event metadata

`server/lib/events.js` scrubs a deny list from every event's metadata before it
is written:

```js
const DROP_KEYS = ['password', 'token', 'authorization', 'auth', 'email',
                   'phone', 'message_text', 'body', 'text'];
```

## Three separated layers

| layer | store | key |
|---|---|---|
| Identity | `db.json` — users, sessions | email |
| Behaviour | `events.jsonl` | `u_<sha256(email)[:16]>` |
| ML features | `ml/datasets/` | pseudonymous id only |

The pseudonymous id is stable (so per-user features work) and one-way (so the
event log and every derived dataset can be handled without touching PII). The
mapping exists only in the running server's hash function, not in any file.

Seller identity in training data is likewise hashed — `_seller_key` in the
dataset builder — so seller-reliability features never carry an address.

## Access

* `GET /api/events` — admin only. Raw behaviour is not public.
* `GET /api/admin/*` — admin only, gated on `TM_ADMINS`.
* Non-admin recommendation responses receive `source`, `model_version`,
  `cold_start` and `latency_ms` only — not gate internals, candidate source
  mix, or failure reasons.

## Retention

Raw events are append-only and currently unbounded, which is correct while the
dataset is being built. Before real launch, decide and document:

* an event retention window (24 months is typical for marketplace ranking)
* a deletion path honouring account-deletion requests — because the log is
  pseudonymous, this means deleting rows by `u_<hash>`, which the server can
  recompute from the email at deletion time
* whether `query_text` needs truncation or hashing (it can contain names)
