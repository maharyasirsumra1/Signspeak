import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { verifyGoogleIdToken } from './google-auth.js';

test('verifies Google token signature, issuer, audience, and verified email', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = `test-google-key-${Date.now()}`;
  const fetchImpl = async () => new Response(JSON.stringify({
    keys: [{
      ...publicKey.export({ format: 'jwk' }),
      kid: keyId,
      alg: 'RS256',
      use: 'sig'
    }]
  }), {
    headers: { 'cache-control': 'public, max-age=300' }
  });
  const now = Math.floor(Date.now() / 1000);
  const baseClaims = {
    iss: 'https://accounts.google.com',
    aud: 'test-client-id',
    sub: 'google-subject',
    email: 'user@example.test',
    email_verified: true,
    name: 'Test User',
    iat: now,
    exp: now + 60
  };

  const token = createSignedToken(baseClaims, keyId, privateKey);
  const identity = await verifyGoogleIdToken(token, 'test-client-id', fetchImpl);
  assert.deepEqual(identity, {
    subject: 'google-subject',
    email: 'user@example.test',
    displayName: 'Test User'
  });

  await assert.rejects(
    verifyGoogleIdToken(createSignedToken(baseClaims, keyId, privateKey), 'another-client-id', fetchImpl),
    (error) => error.status === 401
  );
  await assert.rejects(
    verifyGoogleIdToken(
      createSignedToken({ ...baseClaims, email_verified: false }, keyId, privateKey),
      'test-client-id',
      fetchImpl
    ),
    (error) => error.status === 401
  );
});

function createSignedToken(claims, keyId, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}
