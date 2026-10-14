/* Turns an adapter outcome into the minimal stored identity record, and decides
   whether it earns the "Verified with digital ID" badge.

   Stored: verified, method, wallet, issuer, givenName, familyName, verifiedAt,
   checks. Never stored: birth date, document number, portrait, address or any
   other element a wallet might release. The names are kept only so the badge
   can be re-checked against the account's display name. */

const REASONS = {
  CANCELLED: 'Verification was cancelled in the wallet.',
  SIGNATURE_INVALID: 'The credential signature could not be verified.',
  ISSUER_NOT_TRUSTED: 'The credential issuer is not on the trusted list.',
  DOCUMENT_EXPIRED: 'The credential has expired.',
  NAME_NOT_RELEASED: 'The wallet did not share a name, so it cannot be matched to your account.',
  NAME_MISMATCH: 'The name on your ID does not match your account name. Update your account name to match your ID and try again.',
  SESSION_NOT_FOUND: 'This verification session has expired. Start again.',
  SESSION_TIMEOUT: 'The wallet did not respond in time. Start again.',
  VERIFICATION_FAILED: 'The credential could not be verified.'
};

function reasonMessage(code, fallback) {
  return REASONS[code] || fallback || REASONS.VERIFICATION_FAILED;
}

/* Lowercase, strip diacritics and punctuation, split into words. */
function tokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/* Tolerant name match: case, accents, hyphens and middle names are ignored,
   and either name order is accepted. The display name needs at least two words
   so a single first name cannot match anyone who shares it. */
function nameMatches(displayName, givenName, familyName) {
  const d = tokens(displayName);
  const g = tokens(givenName);
  const f = tokens(familyName);
  if (d.length < 2 || !g.length || !f.length) return false;
  const first = d[0], last = d[d.length - 1];
  if (g.indexOf(first) >= 0 && f.indexOf(last) >= 0) return true;
  if (f.indexOf(first) >= 0 && g.indexOf(last) >= 0) return true;
  const joined = d.join('');
  return joined === g.concat(f).join('') || joined === f.concat(g).join('');
}

/* outcome: { status, reason, message, wallet, issuer, givenName, familyName, checks }
   returns { status: 'pending'|'cancelled'|'failed'|'verified', reason, message, record } */
function evaluate(outcome, displayName, method, now) {
  if (!outcome || outcome.status === 'pending') return { status: 'pending' };
  if (outcome.status === 'cancelled') {
    return { status: 'cancelled', reason: 'CANCELLED', message: reasonMessage('CANCELLED') };
  }
  const fail = (code, msg) => ({ status: 'failed', reason: code, message: reasonMessage(code, msg) });
  if (outcome.status !== 'verified') return fail(outcome.reason || 'VERIFICATION_FAILED', outcome.message);

  const c = outcome.checks || {};
  const checks = { signature: c.signature === true, issuerTrusted: c.issuerTrusted === true, notExpired: c.notExpired === true };
  if (!checks.signature) return fail('SIGNATURE_INVALID');
  if (!checks.issuerTrusted) return fail('ISSUER_NOT_TRUSTED');
  if (!checks.notExpired) return fail('DOCUMENT_EXPIRED');
  if (!outcome.givenName || !outcome.familyName) return fail('NAME_NOT_RELEASED');
  if (!nameMatches(displayName, outcome.givenName, outcome.familyName)) return fail('NAME_MISMATCH');

  return {
    status: 'verified',
    record: {
      verified: true,
      method: method,
      wallet: outcome.wallet || null,
      issuer: outcome.issuer || null,
      givenName: String(outcome.givenName),
      familyName: String(outcome.familyName),
      verifiedAt: now || Date.now(),
      checks: checks
    }
  };
}

module.exports = { evaluate, nameMatches, tokens, reasonMessage, REASONS };
