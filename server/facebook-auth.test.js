import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyFacebookAccessToken } from './facebook-auth.js';

test('validates Facebook app ownership and profile before returning an identity', async () => {
  const now = Math.floor(Date.now() / 1000);
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (new URL(url).pathname.endsWith('/debug_token')) {
      return new Response(JSON.stringify({
        data: {
          is_valid: true,
          app_id: 'test-app-id',
          user_id: 'facebook-subject',
          expires_at: now + 60,
          scopes: ['public_profile', 'email']
        }
      }));
    }
    return new Response(JSON.stringify({
      id: 'facebook-subject',
      name: 'Test User',
      email: 'user@example.test'
    }));
  };

  const identity = await verifyFacebookAccessToken(
    'test-access-token',
    'test-app-id',
    'test-app-secret',
    fetchImpl
  );
  assert.deepEqual(identity, {
    subject: 'facebook-subject',
    email: 'user@example.test',
    displayName: 'Test User'
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-app-id|test-app-secret');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer test-access-token');

  await assert.rejects(
    verifyFacebookAccessToken('test-access-token', 'other-app-id', 'test-app-secret', fetchImpl),
    (error) => error.status === 401
  );
});
