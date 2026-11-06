// If a token looks like a JWT, report only: algorithm, claim NAMES, and the lifetime in seconds.
// Claim values (user ids, names) are never returned.

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** @param {unknown} token */
export function describeToken(token) {
  if (typeof token !== 'string') return { present: false };
  const parts = token.split('.');
  const out = { present: true, length: token.length, looksLikeJwt: false };
  if (parts.length !== 3) return out;
  const header = decodePart(parts[0] ?? '');
  const payload = decodePart(parts[1] ?? '');
  if (!header || !payload || typeof payload !== 'object') return out;
  const claims = /** @type {Record<string, unknown>} */ (payload);
  out.looksLikeJwt = true;
  out.alg = typeof header.alg === 'string' ? header.alg : 'unknown';
  out.claimNames = Object.keys(claims).sort();
  if (typeof claims.exp === 'number' && typeof claims.iat === 'number') {
    out.lifetimeSeconds = claims.exp - claims.iat;
  } else if (typeof claims.exp === 'number') {
    out.secondsUntilExpiry = claims.exp - Math.floor(Date.now() / 1000);
  }
  return out;
}
