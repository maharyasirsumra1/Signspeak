import { createPublicKey, verify as verifySignature } from 'node:crypto';

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
let cachedKeys = [];
let keysExpireAt = 0;

export async function verifyGoogleIdToken(token, expectedAudience, fetchImpl = fetch) {
  if (typeof token !== 'string' || token.length > 12_000) {
    throw googleAuthError(401, 'Google sign-in could not be verified. Please try again.');
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[\w-]+$/.test(part))) {
    throw googleAuthError(401, 'Google sign-in could not be verified. Please try again.');
  }

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw googleAuthError(401, 'Google sign-in could not be verified. Please try again.');
  }

  if (
    !header
    || typeof header !== 'object'
    || Array.isArray(header)
    || !claims
    || typeof claims !== 'object'
    || Array.isArray(claims)
    || header.alg !== 'RS256'
    || typeof header.kid !== 'string'
  ) {
    throw googleAuthError(401, 'Google sign-in could not be verified. Please try again.');
  }

  const key = await getGoogleSigningKey(header.kid, fetchImpl);
  let signatureIsValid = false;
  try {
    signatureIsValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url')
    );
  } catch {
    throw googleAuthError(401, 'Google sign-in could not be verified. Please try again.');
  }

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !signatureIsValid
    || !GOOGLE_ISSUERS.has(claims.iss)
    || !audiences.includes(expectedAudience)
    || (claims.azp && claims.azp !== expectedAudience)
    || (audiences.length > 1 && claims.azp !== expectedAudience)
    || !Number.isFinite(claims.exp)
    || claims.exp <= now
    || (Number.isFinite(claims.iat) && claims.iat > now + 60)
    || typeof claims.sub !== 'string'
    || !claims.sub
    || claims.sub.length > 255
    || typeof claims.email !== 'string'
    || claims.email.length > 254
    || claims.email_verified !== true
  ) {
    throw googleAuthError(401, 'Google sign-in could not be verified. Please try again.');
  }

  return {
    subject: claims.sub,
    email: claims.email.trim().toLowerCase(),
    displayName: typeof claims.name === 'string' ? claims.name : ''
  };
}

async function getGoogleSigningKey(keyId, fetchImpl) {
  const now = Date.now();
  if (keysExpireAt <= now || !cachedKeys.length) {
    await refreshGoogleKeys(fetchImpl);
  }

  let key = cachedKeys.find((candidate) => candidate.kid === keyId);
  if (!key) {
    keysExpireAt = 0;
    await refreshGoogleKeys(fetchImpl);
    key = cachedKeys.find((candidate) => candidate.kid === keyId);
  }
  if (!key) throw googleAuthError(401, 'Google sign-in could not be verified. Please try again.');
  return key;
}

async function refreshGoogleKeys(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw googleAuthError(503, 'Google sign-in is temporarily unavailable. Please try again.');
  }
  if (!response.ok) {
    throw googleAuthError(503, 'Google sign-in is temporarily unavailable. Please try again.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw googleAuthError(503, 'Google sign-in is temporarily unavailable. Please try again.');
  }
  if (!Array.isArray(payload.keys)) {
    throw googleAuthError(503, 'Google sign-in is temporarily unavailable. Please try again.');
  }

  cachedKeys = payload.keys.filter((key) => key.kty === 'RSA' && key.kid && key.n && key.e);
  const maxAge = response.headers.get('cache-control')?.match(/max-age=(\d+)/i);
  keysExpireAt = Date.now() + (maxAge ? Number(maxAge[1]) : 300) * 1000;
}

function googleAuthError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
