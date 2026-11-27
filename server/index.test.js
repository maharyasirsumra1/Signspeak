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
const application = createSignSpeakServer({ host: '127.0.0.1', port: 0 });
const address = await application.listen();
const origin = `http://127.0.0.1:${address.port}`;

after(async () => {
  await application.close();
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('supports verified accounts, accepted contacts, and relayed call captions', async () => {
  const alice = await createVerifiedAccount('Alice', 'alice@example.test');
  const bob = await createVerifiedAccount('Bob', 'bob@example.test');

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

async function createVerifiedAccount(displayName, email) {
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { displayName, email, password: 'a-long-test-password-2026' }
  });
  assert.equal(registration.status, 201);
  const verificationUrl = new URL(registration.payload.developmentVerificationUrl);
  const token = verificationUrl.searchParams.get('verify');
  const verification = await request(`/api/auth/verify?token=${encodeURIComponent(token)}`);
  assert.equal(verification.status, 200);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'a-long-test-password-2026' }
  });
  assert.equal(login.status, 200);
  return {
    email,
    cookie: login.cookie
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
