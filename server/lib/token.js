/* Signed session tokens: "tm1.<payload>.<signature>", base64url, HMAC-SHA256.

   Any instance holding the secret can verify a token without shared state,
   which is what keeps a sign-in alive across serverless instances. Claims:
     e   email
     n   display name at issue time
     x   expiry, epoch milliseconds
     id  identity record when the digital ID badge was earned, otherwise null
*/
const crypto = require('crypto');
const cfg = require('./config');
const log = require('./log');

const PREFIX = 'tm1';

let cachedSecret = null;

/** TM_SESSION_SECRET, else a random per-instance key. */
function secret() {
  if (cachedSecret) return cachedSecret;
  if (cfg.SESSION_SECRET) {
    cachedSecret = cfg.SESSION_SECRET;
  } else if (cfg.IS_VERCEL) {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    log.warn('auth', 'TM_SESSION_SECRET is not set: using a random per-instance key, so sign-ins will not carry across ' +
      'serverless instances. Set TM_SESSION_SECRET to a long random value.');
  } else {
    cachedSecret = crypto.randomBytes(32).toString('hex');
  }
  return cachedSecret;
}

function mac(body, key) {
  return crypto.createHmac('sha256', key).update(PREFIX + '.' + body).digest('base64url');
}

/** A separate key per purpose, so a value sealed for one use never verifies as another. */
function keyFor(purpose) {
  return crypto.createHmac('sha256', secret()).update('purpose|' + purpose).digest('hex');
}

/** Seal any JSON object. `x` (expiry, epoch ms) is checked on open when present. */
function seal(obj, key) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return PREFIX + '.' + body + '.' + mac(body, key);
}

function unseal(value, key, now) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;
  const expected = Buffer.from(mac(parts[1], key));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.x !== undefined && (typeof obj.x !== 'number' || obj.x < (now || Date.now()))) return null;
  return obj;
}

function sign(claims, key) { return seal(claims, key || secret()); }

/** Session claims, or null when the token is malformed, tampered with or expired. */
function verify(token, key, now) {
  const claims = unseal(token, key || secret(), now);
  if (!claims || typeof claims.e !== 'string' || typeof claims.x !== 'number') return null;
  return claims;
}

function isSigned(token) { return String(token || '').indexOf(PREFIX + '.') === 0; }

module.exports = { sign, verify, isSigned, secret, keyFor, seal, unseal };
