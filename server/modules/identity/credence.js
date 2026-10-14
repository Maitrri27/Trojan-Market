/* Credence ID Cloud SDK adapter (REST).

   This is the only file that knows Credence endpoint paths and response field
   names. Everything it returns is the adapter-neutral shape used by every
   adapter:

     startDc({flow})              -> { sessionId, protocol, data }
     verifyDc({flow, sessionId, data}) -> outcome
     startQr({flow, returnUrl})   -> { sessionId, walletUri }
     pollQr({flow, sessionId})    -> outcome | { status: 'pending' }

     outcome = { status: 'verified'|'failed'|'cancelled', reason, message,
                 wallet, issuer, givenName, familyName,
                 checks: { signature, issuerTrusted, notExpired } }

   Flows (see README):
     DC API      'mdoc'      POST /v1/getDocRequest -> /v1/verifyDocRequest
                 'openid4vp' POST /dcapi/openid4vp/v1/initiate -> /validate
     QR / link   'mdoc'      POST /openid4vp/v1/mdoc/initiate -> /result (poll)
                 'w3c'       POST /w3c/openid4vp/v1/initiate -> /validate (poll)

   The license key is sent only from this server to Credence and is never
   included in anything returned to the browser. */

const ACCESS_SKEW_MS = 60 * 1000;
const REFRESH_TTL_MS = 7 * 24 * 3600 * 1000;
const RETRY_TOKEN_CODES = ['TOKEN_EXPIRED', 'INVALID_TOKEN', 'MISSING_TOKEN'];

const ERROR_MESSAGES = {
  DOMAIN_MISMATCH: 'This site\'s origin is not registered for the Credence ID license.',
  INVALID_LICENSE_KEY: 'The Credence ID license key is not valid.',
  LICENSE_EXPIRED_OR_REVOKED: 'The Credence ID license has expired or been revoked.',
  PROFILE_NOT_FOUND: 'The Credence ID profile was not found.',
  PROFILE_NOT_SUPPORTED: 'The Credence ID profile does not support this flow.',
  RATE_LIMIT_EXCEEDED: 'Too many verification attempts. Wait a minute and try again.',
  PLAN_LIMIT_EXCEEDED: 'The monthly verification quota has been reached.',
  READER_AUTH_UNAVAILABLE: 'The verification service is temporarily unavailable.',
  UPSTREAM_ERROR: 'The verification service is temporarily unavailable.',
  INTERNAL_ERROR: 'The verification service reported an internal error.',
  TIMEOUT: 'The verification service did not respond in time.',
  NETWORK_ERROR: 'The verification service could not be reached.'
};

class CredenceError extends Error {
  constructor(code, status, detail) {
    super(ERROR_MESSAGES[code] || detail || ('Credence ID request failed (' + code + ').'));
    this.name = 'CredenceError';
    this.code = code;
    this.status = status || 0;
    this.detail = detail || null;
  }
}

const WALLETS = {
  'dc:mdoc': 'ISO mdoc wallet (Digital Credentials API)',
  'dc:openid4vp': 'OpenID4VP wallet (Digital Credentials API)',
  'qr:mdoc': 'ISO mdoc wallet (QR / link)',
  'qr:w3c': 'W3C VC wallet (QR / link)'
};

/* ------------------------------------------------------------ parsing */

function parseJsonish(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
}

function normKey(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/* Depth-first search for the first value under any of `names`. Handles plain
   objects, namespaced mdoc objects and [{elementIdentifier, elementValue}]. */
function findValue(obj, names, depth) {
  if (obj == null || typeof obj !== 'object' || (depth || 0) > 6) return undefined;
  const wanted = names.map(normKey);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object' && item.elementIdentifier !== undefined &&
          wanted.indexOf(normKey(item.elementIdentifier)) >= 0) return item.elementValue;
      const v = findValue(item, names, (depth || 0) + 1);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  for (const k of Object.keys(obj)) {
    if (wanted.indexOf(normKey(k)) >= 0 && (typeof obj[k] !== 'object' || obj[k] === null)) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const v = findValue(parseJsonish(obj[k]), names, (depth || 0) + 1);
    if (v !== undefined) return v;
  }
  return undefined;
}

function claimString(obj, names) {
  const v = findValue(obj, names);
  return v === undefined || v === null || v === '' ? null : String(v);
}

/* A check is false if any matching boolean is false; true if at least one is
   true; `fallback` when the response does not report it at all. */
function checkFrom(obj, names, fallback, inverted) {
  const seen = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return;
    Object.keys(o).forEach((k) => {
      const v = parseJsonish(o[k]);
      if (typeof v === 'boolean' && names.map(normKey).indexOf(normKey(k)) >= 0) seen.push(inverted ? !v : v);
      else if (v && typeof v === 'object') walk(v, depth + 1);
    });
  })(obj, 0);
  if (!seen.length) return fallback;
  return seen.every(Boolean);
}

const GIVEN = ['given_name', 'givenName', 'first_name'];
const FAMILY = ['family_name', 'familyName', 'last_name', 'surname'];
const ISSUER = ['issuing_authority', 'issuingAuthority', 'issuer', 'issuing_country'];

function identityOutcome(identity, auth, wallet, serviceVerified) {
  const signature = checkFrom(auth, ['signatureValid', 'signature', 'issuerAuth', 'issuerAuthValid',
    'issuerSignatureValid', 'deviceAuth', 'deviceAuthValid', 'deviceSignatureValid', 'msoValid'], serviceVerified);
  const trusted = checkFrom(auth, ['issuerTrusted', 'trusted', 'trustChainValid', 'issuerCertificateTrusted'], serviceVerified);
  let notExpired = checkFrom(auth, ['notExpired', 'validityValid', 'validityInfoValid'], serviceVerified);
  if (checkFrom(auth, ['expired', 'isExpired'], false)) notExpired = false;
  return {
    status: 'verified',
    wallet: wallet,
    issuer: claimString(identity, ISSUER) || claimString(auth, ISSUER),
    givenName: claimString(identity, GIVEN),
    familyName: claimString(identity, FAMILY),
    checks: { signature: signature, issuerTrusted: trusted, notExpired: notExpired }
  };
}

function failed(reason, message) { return { status: 'failed', reason: reason, message: message || null }; }
function cancelled(message) { return { status: 'cancelled', reason: 'CANCELLED', message: message || null }; }

/* Flows A/B: { cancelled, message } | { res: true, resDetails: "<json>" } | { res: false, resDetails: "<error>" } */
function parseDcResult(status, j, wallet) {
  j = j || {};
  if (j.cancelled === true) return cancelled(j.message);
  if (j.res === true) {
    const d = parseJsonish(j.resDetails) || {};
    const identity = parseJsonish(d.identity) || d;
    const auth = parseJsonish(d.authentication) || {};
    return identityOutcome(identity, auth, wallet, true);
  }
  if (j.res === false) return failed('VERIFICATION_FAILED', typeof j.resDetails === 'string' ? j.resDetails : null);
  if (status === 400) return failed('VERIFICATION_FAILED', j.message || j.error || null);
  return failed('VERIFICATION_FAILED', 'Unexpected response from the verification service.');
}

/* Flow C: 202 pending | { success, identity: "<json>", error } */
function parseMdocQrResult(status, j, wallet) {
  j = j || {};
  if (status === 202) return { status: 'pending' };
  if (status === 404) return failed('SESSION_NOT_FOUND');
  if (j.success === true) {
    const identity = parseJsonish(j.identity) || {};
    return identityOutcome(identity, identity, wallet, true);
  }
  const err = String(j.error || '');
  if (/denied|declin|cancel/i.test(err)) return cancelled(err);
  if (/timed out|timeout/i.test(err)) return failed('SESSION_TIMEOUT', err);
  return failed('VERIFICATION_FAILED', err || null);
}

/* Flow D: 202 pending | { success, claims, issuer, expirationDate, verificationDetails } */
function parseW3cResult(status, j, wallet, now) {
  j = j || {};
  if (status === 202) return { status: 'pending' };
  if (status === 404) return failed('SESSION_NOT_FOUND');
  if (j.success !== true) {
    const err = String(j.error || '');
    if (/not yet completed|pending/i.test(err)) return { status: 'pending' };
    if (/denied|declin|cancel/i.test(err)) return cancelled(err);
    if (/issuer/i.test(err) && /trust/i.test(err)) return failed('ISSUER_NOT_TRUSTED', err);
    return failed('VERIFICATION_FAILED', err || null);
  }
  const vd = j.verificationDetails || {};
  const yes = (k) => vd[k] !== false;
  const exp = j.expirationDate ? Date.parse(j.expirationDate) : NaN;
  const claims = parseJsonish(j.claims) || {};
  return {
    status: 'verified',
    wallet: wallet,
    issuer: j.issuer ? String(j.issuer) : claimString(claims, ISSUER),
    givenName: claimString(claims, GIVEN),
    familyName: claimString(claims, FAMILY),
    checks: {
      signature: yes('vpSignatureValid') && yes('vcSignatureValid') && yes('nonceMatches') &&
        yes('audienceMatches') && yes('credentialTypeMatches'),
      issuerTrusted: yes('issuerTrusted'),
      notExpired: yes('notExpired') && (isNaN(exp) || exp > now)
    }
  };
}

function errorCode(status, j) {
  const c = j && (j.code || j.errorCode || j.error);
  if (typeof c === 'string' && /^[A-Z][A-Z0-9_]+$/.test(c)) return c;
  if (status === 401) return 'INVALID_TOKEN';
  if (status === 429) return 'RATE_LIMIT_EXCEEDED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'HTTP_' + status;
}

/* ------------------------------------------------------------ adapter */

function createCredenceAdapter(opts) {
  const o = opts || {};
  const baseUrl = String(o.baseUrl || '').replace(/\/+$/, '');
  const fetchImpl = o.fetch || globalThis.fetch;
  const now = o.now || Date.now;
  const timeoutMs = o.timeoutMs || 15000;
  if (!o.licenseKey || !o.profileId) throw new Error('Credence adapter needs a license key and profile id.');
  if (!/^https:\/\//.test(o.origin || '')) throw new Error('Credence adapter needs PUBLIC_ORIGIN set to the registered https origin.');

  let tok = null;              /* { access, refresh, accessExp, refreshExp } */
  let inflight = null;

  async function raw(path, body, headers) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Origin: o.origin }, headers || {}),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined
      });
    } catch (e) {
      throw new CredenceError(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', 0, e && e.message);
    } finally { if (timer) clearTimeout(timer); }
    let text = '';
    try { text = await res.text(); } catch (e) {}
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { message: text }; }
    return { status: res.status, json: json };
  }

  function keep(j) {
    if (!j || !j.accessToken) throw new CredenceError('INVALID_TOKEN', 0, 'Token response had no access token.');
    tok = {
      access: j.accessToken,
      refresh: j.refreshToken || null,
      accessExp: now() + (Number(j.expiresIn) || 900) * 1000,
      refreshExp: now() + REFRESH_TTL_MS
    };
    return tok.access;
  }

  async function setup() {
    const r = await raw('/v1/setup', { licenseKey: o.licenseKey, profileId: o.profileId });
    if (r.status < 200 || r.status >= 300) throw new CredenceError(errorCode(r.status, r.json), r.status, r.json && r.json.message);
    return keep(r.json);
  }

  async function refresh() {
    const r = await raw('/v1/refresh', { refreshToken: tok.refresh });
    if (r.status >= 200 && r.status < 300 && r.json && r.json.accessToken) return keep(r.json);
    tok = null;
    return setup();
  }

  async function token(force) {
    if (!force && tok && tok.accessExp - now() > ACCESS_SKEW_MS) return tok.access;
    if (inflight) return inflight;
    inflight = (tok && tok.refresh && tok.refreshExp > now() ? refresh() : setup());
    try { return await inflight; } finally { inflight = null; }
  }

  /* Authenticated call. Retries once with a fresh token on 401. Statuses in
     `allow` are returned to the caller; any other non-2xx throws. */
  async function call(path, body, allow) {
    let r = await raw(path, body, { Authorization: 'Bearer ' + await token(false) });
    if (r.status === 401 && RETRY_TOKEN_CODES.indexOf(errorCode(401, r.json)) >= 0) {
      if (tok) tok.accessExp = 0;
      r = await raw(path, body, { Authorization: 'Bearer ' + await token(true) });
    }
    const ok = r.status >= 200 && r.status < 300;
    if (!ok && (allow || []).indexOf(r.status) < 0) {
      throw new CredenceError(errorCode(r.status, r.json), r.status, r.json && (r.json.message || r.json.error));
    }
    return r;
  }

  async function startDc(args) {
    const flow = args && args.flow === 'mdoc' ? 'mdoc' : 'openid4vp';
    if (flow === 'mdoc') {
      const r = await call('/v1/getDocRequest', {});
      const dc = r.json.dcRequest || {};
      return { sessionId: r.json.sessionId, protocol: 'org-iso-mdoc', data: dc };
    }
    const r = await call('/dcapi/openid4vp/v1/initiate', {});
    return { sessionId: r.json.sessionId, protocol: 'openid4vp', data: r.json.payload };
  }

  async function verifyDc(args) {
    const flow = args.flow === 'mdoc' ? 'mdoc' : 'openid4vp';
    const path = flow === 'mdoc' ? '/v1/verifyDocRequest' : '/dcapi/openid4vp/v1/validate';
    const r = await call(path, { sessionId: args.sessionId, data: args.data }, [400]);
    return parseDcResult(r.status, r.json, WALLETS['dc:' + flow]);
  }

  async function startQr(args) {
    const flow = args && args.flow === 'w3c' ? 'w3c' : 'mdoc';
    if (flow === 'mdoc') {
      const body = args && args.returnUrl ? { returnUrl: args.returnUrl } : {};
      const r = await call('/openid4vp/v1/mdoc/initiate', body);
      return { sessionId: r.json.sessionId, walletUri: r.json.walletUri };
    }
    const r = await call('/w3c/openid4vp/v1/initiate', {});
    const ar = r.json.authorizationRequest || {};
    return {
      sessionId: r.json.sessionId,
      walletUri: 'openid4vp://authorize?client_id=' + encodeURIComponent(ar.client_id || '') +
        '&request_uri=' + encodeURIComponent(r.json.requestUri || '')
    };
  }

  async function pollQr(args) {
    const flow = args.flow === 'w3c' ? 'w3c' : 'mdoc';
    if (flow === 'mdoc') {
      const r = await call('/openid4vp/v1/mdoc/result', { sessionId: args.sessionId }, [202, 404]);
      return parseMdocQrResult(r.status, r.json, WALLETS['qr:mdoc']);
    }
    const r = await call('/w3c/openid4vp/v1/validate', { sessionId: args.sessionId }, [202, 404]);
    return parseW3cResult(r.status, r.json, WALLETS['qr:w3c'], now());
  }

  return {
    mode: 'credence-cloud',
    startDc, verifyDc, startQr, pollQr,
    token: token,
    tokenState: () => (tok ? { accessExp: tok.accessExp, hasRefresh: !!tok.refresh } : null)
  };
}

module.exports = {
  createCredenceAdapter, CredenceError,
  parseDcResult, parseMdocQrResult, parseW3cResult, parseJsonish, findValue
};
