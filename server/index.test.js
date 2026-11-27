import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import WebSocket from 'ws';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'signspeak-test-'));
process.env.SIGNSPEAK_DB_PATH = join(temporaryDirectory, 'test.sqlite');
process.env.NODE_ENV = 'test';

const { createSignSpeakServer, database } = await import('./index.js');
const googleCredentials = new Map([
  ['new-google-credential', {
    subject: 'google-subject-new',
    email: 'google@example.test',
    displayName: 'Google User'
  }],
  ['alice-google-credential', {
    subject: 'google-subject-alice',
    email: 'alice@example.test',
    displayName: 'Alice from Google'
  }]
]);
const facebookCredentials = new Map([
  ['google-user-facebook-token', {
    subject: 'facebook-subject-google-user',
    email: 'google@example.test',
    displayName: 'Google User'
  }]
]);
const application = createSignSpeakServer({
  host: '127.0.0.1',
  port: 0,
  googleClientId: 'test-google-client.apps.googleusercontent.com',
  googleTokenVerifier: async (credential, audience) => {
    if (audience !== 'test-google-client.apps.googleusercontent.com') {
      throw Object.assign(new Error('Invalid Google audience.'), { status: 401 });
    }
    const identity = googleCredentials.get(credential);
    if (!identity) throw Object.assign(new Error('Invalid Google credential.'), { status: 401 });
    return identity;
  },
  facebookAppId: 'test-facebook-app-id',
  facebookAppSecret: 'test-facebook-app-secret',
  facebookTokenVerifier: async (accessToken, appId, appSecret) => {
    if (appId !== 'test-facebook-app-id' || appSecret !== 'test-facebook-app-secret') {
      throw Object.assign(new Error('Invalid Facebook app configuration.'), { status: 401 });
    }
    const identity = facebookCredentials.get(accessToken);
    if (!identity) throw Object.assign(new Error('Invalid Facebook access token.'), { status: 401 });
    return identity;
  }
});
const address = await application.listen();
const origin = `http://127.0.0.1:${address.port}`;

after(async () => {
  await application.close();
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('supports verified accounts, accepted contacts, and relayed call captions', async () => {
  const tooShortPassword = await request('/api/auth/register', {
    method: 'POST',
    body: { displayName: 'Short Pass', email: 'short-pass@example.test', password: '12345' }
  });
  assert.equal(tooShortPassword.status, 400);

  const sixCharacterPasswordAccount = await createVerifiedAccount(
    'Six Chars',
    'six-chars@example.test',
    '123456'
  );
  assert.ok(sixCharacterPasswordAccount.userId);
  const lettersOnlyPasswordAccount = await createVerifiedAccount(
    'Letters Only',
    'letters-only@example.test',
    'abcdef'
  );
  assert.ok(lettersOnlyPasswordAccount.userId);

  const alice = await createUnverifiedAccount('Alice', 'alice@example.test');
  const bob = await createVerifiedAccount('Bob', 'bob@example.test');

  const socialConfig = await request('/api/auth/social/config');
  assert.equal(socialConfig.payload.googleClientId, 'test-google-client.apps.googleusercontent.com');
  assert.equal(socialConfig.payload.facebookAppId, 'test-facebook-app-id');

  const googleSignup = await request('/api/auth/google', {
    method: 'POST',
    body: { credential: 'new-google-credential' }
  });
  assert.equal(googleSignup.status, 200);
  assert.equal(googleSignup.payload.user.email, 'google@example.test');
  assert.ok(googleSignup.payload.user.emailVerifiedAt);

  const googleSession = await request('/api/auth/me', { cookie: googleSignup.cookie });
  assert.equal(googleSession.payload.user.id, googleSignup.payload.user.id);

  const linkedFacebookLogin = await request('/api/auth/facebook', {
    method: 'POST',
    body: { accessToken: 'google-user-facebook-token' }
  });
  assert.equal(linkedFacebookLogin.status, 200);
  assert.equal(linkedFacebookLogin.payload.user.id, googleSignup.payload.user.id);

  const linkedAccount = await request('/api/auth/google', {
    method: 'POST',
    body: { credential: 'alice-google-credential' }
  });
  assert.equal(linkedAccount.status, 200);
  assert.equal(linkedAccount.payload.user.id, alice.userId);

  const invalidGoogleCredential = await request('/api/auth/google', {
    method: 'POST',
    body: { credential: 'invalid-google-credential' }
  });
  assert.equal(invalidGoogleCredential.status, 401);

  const invalidFacebookToken = await request('/api/auth/facebook', {
    method: 'POST',
    body: { accessToken: 'invalid-facebook-token' }
  });
  assert.equal(invalidFacebookToken.status, 401);

  const unauthenticated = await request('/api/profile');
  assert.equal(unauthenticated.status, 401);

  const iceConfiguration = await request('/api/calls/ice-config', { cookie: alice.cookie });
  assert.equal(iceConfiguration.status, 200);
  assert.ok(iceConfiguration.payload.iceServers.some((server) => server.urls === 'stun:stun.l.google.com:19302'));

  const invite = await request('/api/contacts', {
    method: 'POST',
    cookie: alice.cookie,
    body: { email: bob.email }
  });
  assert.equal(invite.status, 201);

  const incoming = await request('/api/contacts', { cookie: bob.cookie });
  const contact = incoming.payload.contacts.find((entry) => entry.direction === 'incoming');
  assert.ok(contact);
  assert.equal(contact.status, 'pending');

  const accepted = await request(`/api/contacts/${contact.id}/accept`, {
    method: 'POST',
    cookie: bob.cookie
  });
  assert.equal(accepted.status, 200);

  const aliceContacts = await request('/api/contacts', { cookie: alice.cookie });
  const acceptedContact = aliceContacts.payload.contacts.find((entry) => entry.status === 'accepted');
  assert.ok(acceptedContact);

  const aliceSocket = await connectSocket(alice.cookie);
  const bobSocket = await connectSocket(bob.cookie);
  try {
    const aliceOutgoing = nextMessage(aliceSocket, (message) => message.type === 'call:outgoing');
    const bobIncoming = nextMessage(bobSocket, (message) => message.type === 'call:incoming');
    aliceSocket.send(JSON.stringify({
      type: 'call:invite',
      contactId: acceptedContact.id,
      mode: 'deaf-to-hearing'
    }));
    const [outgoing, incomingCall] = await Promise.all([aliceOutgoing, bobIncoming]);
    assert.equal(outgoing.callId, incomingCall.callId);

    const aliceAccepted = nextMessage(aliceSocket, (message) => message.type === 'call:accepted');
    bobSocket.send(JSON.stringify({ type: 'call:accept', callId: outgoing.callId }));
    await aliceAccepted;

    const offer = nextMessage(bobSocket, (message) => message.type === 'webrtc:offer');
    aliceSocket.send(JSON.stringify({
      type: 'webrtc:offer',
      callId: outgoing.callId,
      description: { type: 'offer', sdp: 'test-offer-sdp' }
    }));
    await offer;

    const answer = nextMessage(aliceSocket, (message) => message.type === 'webrtc:answer');
    bobSocket.send(JSON.stringify({
      type: 'webrtc:answer',
      callId: outgoing.callId,
      description: { type: 'answer', sdp: 'test-answer-sdp' }
    }));
    await answer;

    const aliceConnected = nextMessage(aliceSocket, (message) => message.type === 'call:state' && message.status === 'connected');
    const bobConnected = nextMessage(bobSocket, (message) => message.type === 'call:state' && message.status === 'connected');
    aliceSocket.send(JSON.stringify({ type: 'call:ready', callId: outgoing.callId }));
    await Promise.all([aliceConnected, bobConnected]);

    const caption = nextMessage(bobSocket, (message) => message.type === 'caption');
    aliceSocket.send(JSON.stringify({
      type: 'caption',
      callId: outgoing.callId,
      text: 'Hello',
      source: 'sign'
    }));
    const relayedCaption = await caption;
    assert.equal(relayedCaption.text, 'Hello');
    assert.equal(relayedCaption.source, 'sign');

    const bobEnded = nextMessage(bobSocket, (message) => message.type === 'call:ended');
    aliceSocket.send(JSON.stringify({ type: 'call:end', callId: outgoing.callId }));
    await bobEnded;
  } finally {
    aliceSocket.close();
    bobSocket.close();
  }

  const history = await request('/api/calls', { cookie: alice.cookie });
  assert.equal(history.payload.calls.length, 1);
  assert.equal(history.payload.calls[0].status, 'ended');
});

async function createVerifiedAccount(displayName, email, password = 'a-long-test-password-2026') {
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { displayName, email, password }
  });
  assert.equal(registration.status, 201);
  const verificationUrl = new URL(registration.payload.developmentVerificationUrl);
  const token = verificationUrl.searchParams.get('verify');
  const verification = await request(`/api/auth/verify?token=${encodeURIComponent(token)}`);
  assert.equal(verification.status, 200);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  assert.equal(login.status, 200);
  return {
    email,
    cookie: login.cookie,
    userId: login.payload.user.id
  };
}

async function createUnverifiedAccount(displayName, email) {
  const password = 'a-long-test-password-2026';
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { displayName, email, password }
  });
  assert.equal(registration.status, 201);
  const originalToken = new URL(registration.payload.developmentVerificationUrl)
    .searchParams.get('verify');

  const unverifiedLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  assert.equal(unverifiedLogin.status, 403);

  const unknownAccountResend = await request('/api/auth/verification/resend', {
    method: 'POST',
    body: { email: 'unknown@example.test' }
  });
  assert.equal(unknownAccountResend.status, 200);
  assert.equal(
    unknownAccountResend.payload.message,
    'If an unverified account exists for this email, a verification link has been sent.'
  );
  assert.equal(unknownAccountResend.payload.developmentVerificationUrl, undefined);

  const resend = await request('/api/auth/verification/resend', {
    method: 'POST',
    body: { email }
  });
  assert.equal(resend.status, 200);
  const verificationToken = new URL(resend.payload.developmentVerificationUrl)
    .searchParams.get('verify');
  assert.ok(verificationToken);

  const expiredLink = await request(`/api/auth/verify?token=${encodeURIComponent(originalToken)}`);
  assert.equal(expiredLink.status, 400);

  const verification = await request(`/api/auth/verify?token=${encodeURIComponent(verificationToken)}`);
  assert.equal(verification.status, 200);
  assert.equal(verification.payload.user.email, email);
  assert.ok(verification.cookie);

  const currentUser = await request('/api/auth/me', { cookie: verification.cookie });
  assert.equal(currentUser.payload.user.id, verification.payload.user.id);

  const verifiedAccountResend = await request('/api/auth/verification/resend', {
    method: 'POST',
    body: { email }
  });
  assert.equal(verifiedAccountResend.status, 200);
  assert.equal(verifiedAccountResend.payload.developmentVerificationUrl, undefined);
  return {
    email,
    cookie: verification.cookie,
    userId: verification.payload.user.id
  };
}

async function request(path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  const setCookie = response.headers.get('set-cookie') || '';
  return {
    status: response.status,
    payload,
    cookie: setCookie.split(';')[0]
  };
}

async function connectSocket(cookie) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/signaling`, {
    headers: { Cookie: cookie, Origin: origin }
  });
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });
  return socket;
}

function nextMessage(socket, predicate) {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      socket.off('message', handleMessage);
      rejectMessage(new Error('Timed out waiting for signaling message.'));
    }, 3000);
    const handleMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', handleMessage);
      resolveMessage(message);
    };
    socket.on('message', handleMessage);
  });
}
