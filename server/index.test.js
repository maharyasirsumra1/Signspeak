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

test('supports approved cross-device calls, captions, and authorized phone devices', async () => {
  const tooShortPassword = await request('/api/auth/register', {
    method: 'POST',
    body: { displayName: 'Short Pass', email: 'short-pass@example.test', password: '12345' }
  });
  assert.equal(tooShortPassword.status, 400);

  const sixCharacterPasswordAccount = await createVerifiedAccount(
    'Six Chars',
    'six-chars@example.test',
    '123456',
    'sign_user'
  );
  assert.ok(sixCharacterPasswordAccount.userId);
  assert.throws(() => database.prepare(`
    INSERT INTO users(id, email, username, display_name, password_hash, created_at)
    VALUES ('duplicate-user-id', 'duplicate-user@example.test', 'SIGN_USER', 'Duplicate User', 'test-hash', ?)
  `).run(Date.now()), /UNIQUE constraint failed: users\.username/);

  const lettersOnlyPasswordAccount = await createVerifiedAccount(
    'Letters Only',
    'letters-only@example.test',
    'abcdef'
  );
  assert.ok(lettersOnlyPasswordAccount.userId);

  const alice = await createUnverifiedAccount('Alice', 'alice@example.test');
  const bob = await createVerifiedAccount('Bob', 'bob@example.test');
  database.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(alice.userId);

  const unapprovedDevice = await request('/api/admin/call-devices', {
    method: 'POST',
    cookie: bob.cookie,
    body: {
      userId: bob.userId,
      phoneNumber: '+14155550112',
      deviceName: 'Bob phone',
      deviceType: 'mobile',
      phoneVerified: true,
      callsEnabled: true
    }
  });
  assert.equal(unapprovedDevice.status, 403);

  const aliceDevice = await request('/api/admin/call-devices', {
    method: 'POST',
    cookie: alice.cookie,
    body: {
      userId: alice.userId,
      phoneNumber: '+14155550111',
      deviceName: 'Alice laptop',
      deviceType: 'desktop',
      phoneVerified: true,
      callsEnabled: true
    }
  });
  assert.equal(aliceDevice.status, 201);

  const bobDevice = await request('/api/admin/call-devices', {
    method: 'POST',
    cookie: alice.cookie,
    body: {
      userId: bob.userId,
      phoneNumber: '+14155550112',
      deviceName: 'Bob mobile',
      deviceType: 'mobile',
      phoneVerified: true,
      callsEnabled: true
    }
  });
  assert.equal(bobDevice.status, 201);

  const invalidPhoneDevice = await request('/api/admin/call-devices', {
    method: 'POST',
    cookie: alice.cookie,
    body: {
      userId: bob.userId,
      phoneNumber: '555-1234',
      deviceName: 'Invalid phone',
      deviceType: 'mobile',
      phoneVerified: true,
      callsEnabled: true
    }
  });
  assert.equal(invalidPhoneDevice.status, 400);

  const socialConfig = await request('/api/auth/social/config');
  assert.equal(socialConfig.payload.googleClientId, 'test-google-client.apps.googleusercontent.com');
  assert.equal(socialConfig.payload.facebookAppId, 'test-facebook-app-id');

  const googleSignup = await request('/api/auth/google', {
    method: 'POST',
    body: { credential: 'new-google-credential' }
  });
  assert.equal(googleSignup.status, 200);
  assert.equal(googleSignup.payload.user.email, 'google@example.test');
  assert.ok(googleSignup.payload.user.username);
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
  assert.equal(invite.status, 403);

  const aliceContacts = await request('/api/contacts', { cookie: alice.cookie });
  const approvedContact = aliceContacts.payload.contacts.find((entry) => entry.id === bob.userId);
  assert.ok(approvedContact);
  assert.equal(approvedContact.direction, 'approved');
  assert.equal(aliceContacts.payload.callingEnabled, true);

  const bobContacts = await request('/api/contacts', { cookie: bob.cookie });
  assert.ok(bobContacts.payload.contacts.some((entry) => entry.id === alice.userId));

  const aliceSocket = await connectSocket(alice.cookie);
  const bobSocket = await connectSocket(bob.cookie);
  const bobSecondDeviceSocket = await connectSocket(bob.cookie);
  try {
    const connectedDevices = await request('/api/admin/call-devices', { cookie: alice.cookie });
    const bobDevicePresence = connectedDevices.payload.devices.find((device) => device.id === bobDevice.payload.device.id);
    assert.equal(bobDevicePresence.online, true);
    assert.equal(bobDevicePresence.connectedSessions, 2);

    const aliceOutgoing = nextMessage(aliceSocket, (message) => message.type === 'call:outgoing');
    const bobIncoming = nextMessage(bobSocket, (message) => message.type === 'call:incoming');
    const bobSecondDeviceIncoming = nextMessage(
      bobSecondDeviceSocket,
      (message) => message.type === 'call:incoming'
    );
    aliceSocket.send(JSON.stringify({
      type: 'call:invite',
      contactId: approvedContact.id,
      mode: 'deaf-to-hearing'
    }));
    const [outgoing, incomingCall, secondDeviceIncoming] = await Promise.all([
      aliceOutgoing,
      bobIncoming,
      bobSecondDeviceIncoming
    ]);
    assert.equal(outgoing.callId, incomingCall.callId);
    assert.equal(outgoing.callId, secondDeviceIncoming.callId);

    const aliceAccepted = nextMessage(aliceSocket, (message) => message.type === 'call:accepted');
    const bobSecondDeviceClaimed = nextMessage(
      bobSecondDeviceSocket,
      (message) => message.type === 'call:claimed'
    );
    bobSocket.send(JSON.stringify({ type: 'call:accept', callId: outgoing.callId }));
    await Promise.all([aliceAccepted, bobSecondDeviceClaimed]);

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
    bobSecondDeviceSocket.close();
  }

  const history = await request('/api/calls', { cookie: alice.cookie });
  assert.equal(history.payload.calls.length, 1);
  assert.equal(history.payload.calls[0].status, 'ended');

  const disableBobCalling = await request(
    `/api/admin/call-devices/${bobDevice.payload.device.id}`,
    {
      method: 'PATCH',
      cookie: alice.cookie,
      body: { callsEnabled: false }
    }
  );
  assert.equal(disableBobCalling.status, 200);
  const contactsAfterRevocation = await request('/api/contacts', { cookie: alice.cookie });
  assert.equal(contactsAfterRevocation.payload.contacts.some((contact) => contact.id === bob.userId), false);

  const nonAdminAccess = await request('/api/admin/dashboard', { cookie: bob.cookie });
  assert.equal(nonAdminAccess.status, 403);

  const promoteBob = await request(`/api/admin/users/${bob.userId}/role`, {
    method: 'PATCH',
    cookie: alice.cookie,
    body: { role: 'admin' }
  });
  assert.equal(promoteBob.status, 200);

  const adminDashboardDenied = await request('/api/admin/dashboard', { cookie: bob.cookie });
  assert.equal(adminDashboardDenied.status, 403);
  const permissions = [
    'admin.access',
    'users.read',
    'users.manage',
    'sessions.read',
    'sessions.revoke',
    'logs.auth.read',
    'logs.activity.read',
    'audit.read',
    'reports.read'
  ];
  const grantPermissions = await request(`/api/admin/admins/${bob.userId}/permissions`, {
    method: 'PUT',
    cookie: alice.cookie,
    body: { permissions }
  });
  assert.equal(grantPermissions.status, 200);

  const dashboard = await request('/api/admin/dashboard', { cookie: bob.cookie });
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.payload.dashboard.users.totalUsers >= 5);
  assert.ok(dashboard.payload.dashboard.authentication.successfulLogins > 0);

  const passwordResetRequest = await request('/api/auth/password-reset/request', {
    method: 'POST',
    body: { email: sixCharacterPasswordAccount.email }
  });
  assert.equal(passwordResetRequest.status, 200);
  assert.match(passwordResetRequest.payload.message, /If an active, verified account exists/);
  assert.ok(new URL(passwordResetRequest.payload.developmentResetUrl).searchParams.get('reset'));

  const unknownPasswordResetRequest = await request('/api/auth/password-reset/request', {
    method: 'POST',
    body: { email: 'unknown@example.test' }
  });
  assert.equal(unknownPasswordResetRequest.status, 200);
  assert.equal(unknownPasswordResetRequest.payload.message, passwordResetRequest.payload.message);
  assert.equal(unknownPasswordResetRequest.payload.developmentResetUrl, undefined);

  const searchUsers = await request('/api/admin/users?q=Six%20Chars&status=active', { cookie: bob.cookie });
  assert.equal(searchUsers.status, 200);
  assert.equal(searchUsers.payload.users[0].id, sixCharacterPasswordAccount.userId);

  const suspendUser = await request(`/api/admin/users/${sixCharacterPasswordAccount.userId}`, {
    method: 'PATCH',
    cookie: bob.cookie,
    body: { accountStatus: 'suspended' }
  });
  assert.equal(suspendUser.status, 200);
  const suspendedSession = await request('/api/auth/me', { cookie: sixCharacterPasswordAccount.cookie });
  assert.equal(suspendedSession.status, 401);

  const reactivateUser = await request(`/api/admin/users/${sixCharacterPasswordAccount.userId}`, {
    method: 'PATCH',
    cookie: bob.cookie,
    body: { accountStatus: 'active' }
  });
  assert.equal(reactivateUser.status, 200);
  const freshLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: sixCharacterPasswordAccount.email, password: '123456' }
  });
  assert.equal(freshLogin.status, 200);

  const invalidProfileImage = await request('/api/profile', {
    method: 'PATCH',
    cookie: bob.cookie,
    body: { displayName: 'Bob', profileImageUrl: 'javascript:alert(1)' }
  });
  assert.equal(invalidProfileImage.status, 400);
  const validProfileImage = await request('/api/profile', {
    method: 'PATCH',
    cookie: bob.cookie,
    body: { displayName: 'Bob', profileImageUrl: 'https://images.example.test/bob.png' }
  });
  assert.equal(validProfileImage.payload.user.profileImageUrl, 'https://images.example.test/bob.png');

  const invalidAdminImage = await request(`/api/admin/users/${sixCharacterPasswordAccount.userId}`, {
    method: 'PATCH',
    cookie: bob.cookie,
    body: { profileImageUrl: 'http://images.example.test/user.png' }
  });
  assert.equal(invalidAdminImage.status, 400);
  const validAdminImage = await request(`/api/admin/users/${sixCharacterPasswordAccount.userId}`, {
    method: 'PATCH',
    cookie: bob.cookie,
    body: { profileImageUrl: 'https://images.example.test/user.png' }
  });
  assert.equal(validAdminImage.payload.user.profileImage, 'https://images.example.test/user.png');

  const activityPost = await request('/api/activity', {
    method: 'POST',
    cookie: freshLogin.cookie,
    body: { action: 'screenshot_created' }
  });
  assert.equal(activityPost.status, 202);
  const activityLogs = await request('/api/admin/activity', { cookie: bob.cookie });
  assert.ok(activityLogs.payload.activity.some((event) => event.action === 'screenshot_created'));

  const sessions = await request('/api/admin/sessions', { cookie: bob.cookie });
  const userSession = sessions.payload.sessions.find((session) => session.userId === sixCharacterPasswordAccount.userId);
  assert.ok(userSession);
  const revokeSession = await request(`/api/admin/sessions/${userSession.id}/revoke`, {
    method: 'POST',
    cookie: bob.cookie
  });
  assert.equal(revokeSession.status, 200);
  const revokedSession = await request('/api/auth/me', { cookie: freshLogin.cookie });
  assert.equal(revokedSession.status, 401);

  const preResetLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: sixCharacterPasswordAccount.email, password: '123456' }
  });
  const resetInstructions = await request(
    `/api/admin/users/${sixCharacterPasswordAccount.userId}/password-reset`,
    { method: 'POST', cookie: bob.cookie }
  );
  assert.equal(resetInstructions.status, 200);
  const resetToken = new URL(resetInstructions.payload.developmentResetUrl).searchParams.get('reset');
  assert.ok(resetToken);
  const resetComplete = await request('/api/auth/password-reset/complete', {
    method: 'POST',
    body: { token: resetToken, password: 'new-test-reset-password-2026' }
  });
  assert.equal(resetComplete.status, 200);
  assert.equal((await request('/api/auth/me', { cookie: preResetLogin.cookie })).status, 401);
  assert.equal((await request('/api/auth/password-reset/complete', {
    method: 'POST',
    body: { token: resetToken, password: 'another-test-password-2026' }
  })).status, 400);
  assert.equal((await request('/api/auth/login', {
    method: 'POST',
    body: { email: sixCharacterPasswordAccount.email, password: '123456' }
  })).status, 401);
  assert.equal((await request('/api/auth/login', {
    method: 'POST',
    body: { email: sixCharacterPasswordAccount.email, password: 'new-test-reset-password-2026' }
  })).status, 200);

  const softDelete = await request(`/api/admin/users/${lettersOnlyPasswordAccount.userId}`, {
    method: 'DELETE',
    cookie: bob.cookie
  });
  assert.equal(softDelete.status, 200);
  const restore = await request(`/api/admin/users/${lettersOnlyPasswordAccount.userId}/restore`, {
    method: 'POST',
    cookie: bob.cookie
  });
  assert.equal(restore.status, 200);
  assert.equal(restore.payload.user.accountStatus, 'active');

  const authEvents = await request('/api/admin/auth-events?type=login_failed', { cookie: bob.cookie });
  assert.ok(authEvents.payload.events.some((event) => event.eventType === 'login_failed'));
  const auditLogs = await request('/api/admin/audit-logs', { cookie: bob.cookie });
  assert.ok(auditLogs.payload.logs.some((entry) => entry.action === 'user_restored'));
  assert.throws(() => database.prepare('DELETE FROM admin_audit_logs').run(), /append-only/);

  const selfRoleChange = await request(`/api/admin/users/${bob.userId}/role`, {
    method: 'PATCH',
    cookie: bob.cookie,
    body: { role: 'super_admin' }
  });
  assert.equal(selfRoleChange.status, 403);

  const incorrectProfilePassword = await request('/api/admin/profile', {
    method: 'PATCH',
    cookie: alice.cookie,
    body: { username: 'alice_admin', currentPassword: 'incorrect-password' }
  });
  assert.equal(incorrectProfilePassword.status, 401);

  const updatedAdminProfile = await request('/api/admin/profile', {
    method: 'PATCH',
    cookie: alice.cookie,
    body: {
      username: 'alice_admin',
      currentPassword: 'a-long-test-password-2026',
      newPassword: 'new-admin-password-2026'
    }
  });
  assert.equal(updatedAdminProfile.status, 200);
  assert.equal(updatedAdminProfile.payload.profile.username, 'alice_admin');
  assert.equal((await request('/api/admin/profile', { cookie: alice.cookie })).status, 200);

  const oldAdminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'alice', password: 'a-long-test-password-2026' }
  });
  assert.equal(oldAdminLogin.status, 401);
  const newAdminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'alice_admin', password: 'new-admin-password-2026' }
  });
  assert.equal(newAdminLogin.status, 200);

  const updatedAdminEmail = await request('/api/admin/profile', {
    method: 'PATCH',
    cookie: newAdminLogin.cookie,
    body: {
      email: 'alice.updated@example.test',
      currentPassword: 'new-admin-password-2026'
    }
  });
  assert.equal(updatedAdminEmail.status, 200);
  assert.equal(updatedAdminEmail.payload.profile.email, 'alice.updated@example.test');
  assert.equal(updatedAdminEmail.payload.profile.emailVerifiedAt, null);
  const emailVerificationToken = new URL(updatedAdminEmail.payload.developmentVerificationUrl)
    .searchParams.get('verify');
  assert.ok(emailVerificationToken);
  const verifiedUpdatedEmail = await request(
    `/api/auth/verify?token=${encodeURIComponent(emailVerificationToken)}`
  );
  assert.equal(verifiedUpdatedEmail.status, 200);
  assert.equal(verifiedUpdatedEmail.payload.user.email, 'alice.updated@example.test');
});

async function createVerifiedAccount(
  displayName,
  email,
  password = 'a-long-test-password-2026',
  username = email.split('@')[0]
) {
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { displayName, email, username, password }
  });
  assert.equal(registration.status, 201);
  const verificationUrl = new URL(registration.payload.developmentVerificationUrl);
  const token = verificationUrl.searchParams.get('verify');
  const verification = await request(`/api/auth/verify?token=${encodeURIComponent(token)}`);
  assert.equal(verification.status, 200);
  const verifiedSession = await request('/api/auth/me', { cookie: verification.cookie });
  assert.equal(verifiedSession.payload.user.id, verification.payload.user.id);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { identifier: username, password }
  });
  assert.equal(login.status, 200);
  assert.equal(login.payload.user.username, username);
  return {
    email,
    username,
    cookie: login.cookie,
    userId: login.payload.user.id
  };
}

async function createUnverifiedAccount(displayName, email) {
  const password = 'a-long-test-password-2026';
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { displayName, email, username: email.split('@')[0], password }
  });
  assert.equal(registration.status, 201);
  assert.equal(
    registration.payload.message,
    'Account created. You can now sign in with your email and password.'
  );
  const originalToken = new URL(registration.payload.developmentVerificationUrl)
    .searchParams.get('verify');

  const unverifiedLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { identifier: email.split('@')[0], password }
  });
  assert.equal(unverifiedLogin.status, 200);
  assert.ok(unverifiedLogin.cookie);
  assert.equal(unverifiedLogin.payload.user.email, email);
  assert.equal(unverifiedLogin.payload.user.emailVerifiedAt, null);
  const unverifiedSession = await request('/api/auth/me', { cookie: unverifiedLogin.cookie });
  assert.equal(unverifiedSession.payload.user.email, email);

  const unknownAccountResend = await request('/api/auth/verification/resend', {
    method: 'POST',
    body: { email: 'unknown@example.test' }
  });
  assert.equal(unknownAccountResend.status, 200);
  assert.equal(
    unknownAccountResend.payload.message,
    'If an unverified account exists for this email or username, a verification link has been sent.'
  );
  assert.equal(unknownAccountResend.payload.developmentVerificationUrl, undefined);

  const resend = await request('/api/auth/verification/resend', {
    method: 'POST',
    body: { identifier: email.split('@')[0] }
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
