import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { db as defaultDatabase } from './db.js';
import { verifyFacebookAccessToken } from './facebook-auth.js';
import { verifyGoogleIdToken } from './google-auth.js';
import { sendVerificationEmail } from './mailer.js';
import { createToken, hashPassword, hashToken, verifyPassword } from './security.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 30 * 60 * 1000;
const CALL_RING_TTL_MS = 45 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const rateBuckets = new Map();
const socketsByUser = new Map();

export function createSignSpeakServer({
  database = defaultDatabase,
  host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT || 3001),
  googleClientId = process.env.GOOGLE_CLIENT_ID || '',
  googleTokenVerifier = verifyGoogleIdToken,
  facebookAppId = process.env.FACEBOOK_APP_ID || '',
  facebookAppSecret = process.env.FACEBOOK_APP_SECRET || '',
  facebookTokenVerifier = verifyFacebookAccessToken
} = {}) {
  const isTls = Boolean(process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH);
  const server = isTls
    ? createHttpsServer({
      cert: readFileSync(process.env.TLS_CERT_PATH),
      key: readFileSync(process.env.TLS_KEY_PATH)
    }, handleRequest)
    : createHttpServer(handleRequest);

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    perMessageDeflate: false
  });

  server.on('upgrade', async (request, socket, head) => {
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host}`);
      if (requestUrl.pathname !== '/api/signaling') {
        socket.destroy();
        return;
      }
      validateOrigin(request, isTls);
      const user = findUserFromSession(request, database);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.userId = user.id;
        webSocketServer.emit('connection', webSocket, request);
      });
    } catch (error) {
      if (!error.status) console.error('WebSocket upgrade failed:', error);
      socket.write(`HTTP/1.1 ${error.status || 500} Request Failed\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  });

  webSocketServer.on('connection', (webSocket) => {
    const userSockets = socketsByUser.get(webSocket.userId) || new Set();
    userSockets.add(webSocket);
    socketsByUser.set(webSocket.userId, userSockets);

    webSocket.on('message', async (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
        await handleSignalMessage(webSocket, message, database);
      } catch (error) {
        if (!error.status) console.error('Signaling message failed:', error);
        send(webSocket, {
          type: 'error',
          message: error.status ? error.message : 'Signaling could not be completed.'
        });
      }
    });

    webSocket.on('close', () => {
      userSockets.delete(webSocket);
      if (userSockets.size === 0) socketsByUser.delete(webSocket.userId);
      const calls = database.prepare(`
        SELECT id, caller_id, callee_id FROM calls
        WHERE status IN ('ringing', 'connecting', 'connected')
          AND (caller_id = ? OR callee_id = ?)
      `).all(webSocket.userId, webSocket.userId);
      for (const call of calls) {
        sendToUser(otherParticipant(call, webSocket.userId), {
          type: 'call:reconnecting',
          callId: call.id,
          participantId: webSocket.userId
        });
      }
    });
  });

  function handleRequest(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Cache-Control', 'no-store');
    if (isTls || (process.env.TRUST_PROXY === '1' && request.headers['x-forwarded-proto'] === 'https')) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    void routeRequest(
      request,
      response,
      database,
      isTls,
      { googleClientId, googleTokenVerifier, facebookAppId, facebookAppSecret, facebookTokenVerifier }
    ).catch((error) => {
      if (!error.status || error.status >= 500) console.error('SignSpeak API error:', error);
      if (!response.headersSent) {
        json(response, error.status || 500, {
          error: error.status ? error.message : 'The request could not be completed.'
        });
      } else {
        response.destroy();
      }
    });
  }

  return {
    server,
    webSocketServer,
    listen() {
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
          server.removeListener('error', rejectListen);
          resolveListen(server.address());
        });
      });
    },
    close() {
      const clients = [...webSocketServer.clients];
      const clientsClosed = clients.length
        ? new Promise((resolveClients) => {
          let remaining = clients.length;
          for (const client of clients) {
            client.once('close', () => {
              remaining -= 1;
              if (remaining === 0) resolveClients();
            });
            client.close(1001, 'Server shutting down');
          }
        })
        : Promise.resolve();
      webSocketServer.close();
      const httpClosed = new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      return Promise.all([clientsClosed, httpClosed]);
    }
  };
}

async function routeRequest(request, response, database, isTls, providers) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = request.method || 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    json(response, 200, { status: 'ok' });
    return;
  }
  if (method === 'GET' && pathname === '/api/auth/social/config') {
    json(response, 200, {
      googleClientId: providers.googleClientId || null,
      facebookAppId: providers.facebookAppId || null
    });
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') validateOrigin(request, isTls);
  expireOldRecords(database);

  if (method === 'POST' && pathname === '/api/auth/register') {
    enforceRateLimit(request, 'register', 5);
    await register(request, response, database, url);
    return;
  }
  if (method === 'POST' && pathname === '/api/auth/verification/resend') {
    enforceRateLimit(request, 'verification-resend', 5);
    await resendVerification(request, response, database, url);
    return;
  }
  if (method === 'GET' && pathname === '/api/auth/verify') {
    verifyEmail(response, database, url, isTls);
    return;
  }
  if (method === 'POST' && pathname === '/api/auth/login') {
    enforceRateLimit(request, 'login', 10);
    await login(request, response, database, isTls);
    return;
  }
  if (method === 'POST' && pathname === '/api/auth/google') {
    enforceRateLimit(request, 'google-login', 10);
    if (!providers.googleClientId) throw httpError(503, 'Google sign-in is not configured. Set GOOGLE_CLIENT_ID in .env.');
    await loginWithGoogle(request, response, database, isTls, providers.googleClientId, providers.googleTokenVerifier);
    return;
  }
  if (method === 'POST' && pathname === '/api/auth/facebook') {
    enforceRateLimit(request, 'facebook-login', 10);
    if (!providers.facebookAppId || !providers.facebookAppSecret) {
      throw httpError(503, 'Facebook sign-in is not configured. Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env.');
    }
    await loginWithFacebook(
      request,
      response,
      database,
      isTls,
      providers.facebookAppId,
      providers.facebookAppSecret,
      providers.facebookTokenVerifier
    );
    return;
  }
  if (method === 'GET' && pathname === '/api/auth/me') {
    const user = requireUser(request, response, database);
    if (user) json(response, 200, { user });
    return;
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const sessionToken = getCookie(request, 'ss_session');
    if (sessionToken) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(sessionToken));
    clearSessionCookie(response, isTls);
    json(response, 200, { ok: true });
    return;
  }

  const user = requireUser(request, response, database);
  if (!user) return;

  if (method === 'GET' && pathname === '/api/profile') {
    json(response, 200, { user, settings: getSettings(database, user.id) });
    return;
  }
  if (method === 'PATCH' && pathname === '/api/profile') {
    const body = await readJson(request);
    const displayName = cleanText(body.displayName, 2, 80);
    if (!displayName) throw httpError(400, 'Display name must be between 2 and 80 characters.');
    database.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, user.id);
    json(response, 200, { user: getPublicUser(database, user.id) });
    return;
  }
  if (method === 'GET' && pathname === '/api/settings') {
    json(response, 200, { settings: getSettings(database, user.id) });
    return;
  }
  if (method === 'PATCH' && pathname === '/api/settings') {
    const body = await readJson(request);
    if (!body || Object.keys(body).length > 20) throw httpError(400, 'Invalid settings payload.');
    const current = getSettings(database, user.id);
    const next = { ...current, ...body };
    if (JSON.stringify(next).length > 4096) throw httpError(400, 'Settings payload is too large.');
    database.prepare(`
      INSERT INTO user_settings(user_id, settings_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
    `).run(user.id, JSON.stringify(next), Date.now());
    json(response, 200, { settings: next });
    return;
  }
  if (method === 'GET' && pathname === '/api/contacts') {
    json(response, 200, { contacts: listContacts(database, user.id) });
    return;
  }
  if (method === 'POST' && pathname === '/api/contacts') {
    enforceRateLimit(request, 'contact-invite', 20, user.id);
    await createContactInvite(request, response, database, user);
    return;
  }
  const contactAction = pathname.match(/^\/api\/contacts\/([0-9a-f-]{36})\/(accept|decline)$/i);
  if (method === 'POST' && contactAction) {
    respondToContactInvite(response, database, user.id, contactAction[1], contactAction[2]);
    return;
  }
  const contactDelete = pathname.match(/^\/api\/contacts\/([0-9a-f-]{36})$/i);
  if (method === 'DELETE' && contactDelete) {
    const result = database.prepare(`
      DELETE FROM contacts WHERE id = ? AND (requester_id = ? OR addressee_id = ?)
    `).run(contactDelete[1], user.id, user.id);
    if (!result.changes) throw httpError(404, 'Contact request not found.');
    json(response, 200, { ok: true });
    return;
  }
  if (method === 'GET' && pathname === '/api/calls') {
    const calls = database.prepare(`
      SELECT c.id, c.mode, c.status, c.created_at, c.answered_at, c.ended_at,
             CASE WHEN c.caller_id = ? THEN callee.display_name ELSE caller.display_name END AS participant
      FROM calls c
      JOIN users caller ON caller.id = c.caller_id
      JOIN users callee ON callee.id = c.callee_id
      LEFT JOIN call_history_hidden h ON h.call_id = c.id AND h.user_id = ?
      WHERE (c.caller_id = ? OR c.callee_id = ?) AND h.call_id IS NULL
      ORDER BY c.created_at DESC LIMIT 3
    `).all(user.id, user.id, user.id, user.id);
    json(response, 200, { calls });
    return;
  }
  if (method === 'GET' && pathname === '/api/calls/ice-config') {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turnUrls = (process.env.TURN_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (turnUrls.length && process.env.TURN_SHARED_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${user.id}`;
      const credential = createHmac('sha1', process.env.TURN_SHARED_SECRET)
        .update(username)
        .digest('base64');
      iceServers.push({
        urls: turnUrls,
        username,
        credential
      });
    }
    json(response, 200, { iceServers });
    return;
  }
  if (method === 'DELETE' && pathname === '/api/calls') {
    database.prepare(`
      INSERT OR IGNORE INTO call_history_hidden(user_id, call_id)
      SELECT ?, id FROM calls WHERE caller_id = ? OR callee_id = ?
    `).run(user.id, user.id, user.id);
    json(response, 200, { ok: true });
    return;
  }
  if (method === 'DELETE' && pathname === '/api/account') {
    const body = await readJson(request);
    const row = database.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!await verifyPassword(body.password || '', row.password_hash)) {
      throw httpError(401, 'Password confirmation failed.');
    }
    database.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    clearSessionCookie(response, isTls);
    json(response, 200, { ok: true });
    return;
  }

  json(response, 404, { error: 'Route not found.' });
}

async function register(request, response, database, requestUrl) {
  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const displayName = cleanText(body.displayName, 2, 80);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw httpError(400, 'Enter a valid email address.');
  }
  if (!displayName) throw httpError(400, 'Display name must be between 2 and 80 characters.');
  if (password.length < 6 || password.length > 128) {
    throw httpError(400, 'Password must be between 6 and 128 characters.');
  }
  if (database.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    throw httpError(409, 'An account with this email already exists.');
  }

  const userId = randomUUID();
  const token = createToken();
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  const insertUser = database.prepare(`
    INSERT INTO users(id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)
  `);
  const insertVerification = database.prepare(`
    INSERT INTO email_verifications(token_hash, user_id, expires_at) VALUES (?, ?, ?)
  `);
  runTransaction(database, () => {
    insertUser.run(userId, email, displayName, passwordHash, now);
    insertVerification.run(hashToken(token), userId, now + VERIFY_TTL_MS);
  });

  const origin = process.env.PUBLIC_ORIGIN || requestUrl.origin;
  const verificationUrl = new URL('/', origin);
  verificationUrl.searchParams.set('verify', token);
  try {
    const mailResult = await sendVerificationEmail({
      email,
      displayName,
      verificationUrl: verificationUrl.toString()
    });
    json(response, 201, {
      message: 'Account created. Verify your email before signing in.',
      ...(mailResult.developmentUrl ? { developmentVerificationUrl: mailResult.developmentUrl } : {})
    });
  } catch (error) {
    database.prepare('DELETE FROM users WHERE id = ?').run(userId);
    throw httpError(503, error.message);
  }
}

async function resendVerification(request, response, database, requestUrl) {
  const body = await readJson(request);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw httpError(400, 'Enter a valid email address.');
  }

  const user = database.prepare(`
    SELECT id, email, display_name, email_verified_at FROM users WHERE email = ?
  `).get(email);
  const message = 'If an unverified account exists for this email, a verification link has been sent.';
  if (!user || user.email_verified_at) {
    json(response, 200, { message });
    return;
  }

  const token = createToken();
  const now = Date.now();
  const origin = process.env.PUBLIC_ORIGIN || requestUrl.origin;
  const verificationUrl = new URL('/', origin);
  verificationUrl.searchParams.set('verify', token);

  let mailResult;
  try {
    mailResult = await sendVerificationEmail({
      email: user.email,
      displayName: user.display_name,
      verificationUrl: verificationUrl.toString()
    });
  } catch {
    throw httpError(503, 'Verification email could not be sent. Please try again later.');
  }

  runTransaction(database, () => {
    database.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);
    database.prepare(`
      INSERT INTO email_verifications(token_hash, user_id, expires_at) VALUES (?, ?, ?)
    `).run(hashToken(token), user.id, now + VERIFY_TTL_MS);
  });
  json(response, 200, {
    message,
    ...(mailResult.developmentUrl ? { developmentVerificationUrl: mailResult.developmentUrl } : {})
  });
}

function verifyEmail(response, database, url, isTls) {
  const token = url.searchParams.get('token') || '';
  if (token.length < 32 || token.length > 128) throw httpError(400, 'Verification link is invalid or expired.');
  const verification = database.prepare(`
    SELECT user_id FROM email_verifications WHERE token_hash = ? AND expires_at > ?
  `).get(hashToken(token), Date.now());
  if (!verification) throw httpError(400, 'Verification link is invalid or expired.');
  runTransaction(database, () => {
    database.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(Date.now(), verification.user_id);
    database.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(verification.user_id);
  });
  const user = establishSession(response, database, verification.user_id, isTls);
  json(response, 200, { message: 'Email verified. You are now signed in.', user });
}

async function login(request, response, database, isTls) {
  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = database.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const validPassword = user && await verifyPassword(password, user.password_hash);
  if (!validPassword) throw httpError(401, 'Email or password is incorrect.');
  if (!user.email_verified_at) throw httpError(403, 'Verify your email before signing in.');

  createSession(response, database, user.id, isTls);
}

async function loginWithGoogle(request, response, database, isTls, clientId, tokenVerifier) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || typeof body.credential !== 'string') {
    throw httpError(400, 'Google sign-in credential is required.');
  }

  const identity = await tokenVerifier(body.credential, clientId);
  await loginWithExternalIdentity(response, database, isTls, 'google', identity);
}

async function loginWithFacebook(request, response, database, isTls, appId, appSecret, tokenVerifier) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || typeof body.accessToken !== 'string') {
    throw httpError(400, 'Facebook sign-in token is required.');
  }
  const identity = await tokenVerifier(body.accessToken, appId, appSecret);
  await loginWithExternalIdentity(response, database, isTls, 'facebook', identity);
}

async function loginWithExternalIdentity(response, database, isTls, provider, identity) {
  if (
    !identity
    || typeof identity.subject !== 'string'
    || identity.subject.length > 255
    || typeof identity.email !== 'string'
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email)
    || identity.email.length > 254
  ) {
    throw httpError(401, `${provider} sign-in could not be verified. Please try again.`);
  }

  const normalizedEmail = identity.email.trim().toLowerCase();
  const linkedIdentity = database.prepare(
    'SELECT user_id FROM external_identities WHERE provider = ? AND subject = ?'
  ).get(provider, identity.subject);
  const existingEmail = database.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  const passwordHash = !linkedIdentity && !existingEmail
    ? await hashPassword(createToken())
    : null;
  const now = Date.now();
  let userId = linkedIdentity?.user_id || null;

  if (!linkedIdentity) {
    try {
      runTransaction(database, () => {
        const linkedInTransaction = database.prepare(
          'SELECT user_id FROM external_identities WHERE provider = ? AND subject = ?'
        ).get(provider, identity.subject);
        const existingInTransaction = database.prepare('SELECT id FROM users WHERE email = ?')
          .get(normalizedEmail);
        userId = linkedInTransaction?.user_id || existingInTransaction?.id || randomUUID();

        if (!existingInTransaction && !linkedInTransaction) {
          const localPart = normalizedEmail.split('@')[0];
          const displayName = cleanText(identity.displayName, 2, 80)
            || cleanText(localPart, 2, 80)
            || `${provider === 'facebook' ? 'Facebook' : 'Google'} user`;
          database.prepare(`
            INSERT INTO users(id, email, display_name, password_hash, email_verified_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(userId, normalizedEmail, displayName, passwordHash, now, now);
        } else {
          database.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
            .run(now, userId);
        }

        if (!linkedInTransaction) {
          database.prepare(`
            INSERT INTO external_identities(provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)
          `).run(provider, identity.subject, userId, now);
        }
      });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' || error.code === 'ERR_SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw httpError(409, `This ${provider} account is already linked to another SignSpeak account.`);
      }
      throw error;
    }
  }

  createSession(response, database, userId, isTls);
}

function createSession(response, database, userId, isTls) {
  const user = establishSession(response, database, userId, isTls);
  json(response, 200, { user });
}

function establishSession(response, database, userId, isTls) {
  const token = createToken();
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  database.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, createdAt, expiresAt);
  response.setHeader('Set-Cookie', sessionCookie(token, expiresAt, isTls));
  return getPublicUser(database, userId);
}

async function createContactInvite(request, response, database, user) {
  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email === user.email) throw httpError(400, 'Enter another verified SignSpeak account email.');
  const target = database.prepare(`
    SELECT id, email_verified_at FROM users WHERE email = ?
  `).get(email);
  if (!target || !target.email_verified_at) throw httpError(404, 'No verified SignSpeak account was found.');

  const existing = database.prepare(`
    SELECT id, status FROM contacts
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).get(user.id, target.id, target.id, user.id);
  if (existing) throw httpError(409, existing.status === 'accepted' ? 'This user is already a contact.' : 'A contact request already exists.');

  const contactId = randomUUID();
  try {
    database.prepare(`
      INSERT INTO contacts(id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)
    `).run(contactId, user.id, target.id, Date.now());
  } catch (error) {
    if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') throw httpError(409, 'A contact request already exists.');
    throw error;
  }
  json(response, 201, { contact: { id: contactId, status: 'pending', email: target.email } });
}

function respondToContactInvite(response, database, userId, contactId, action) {
  const status = action === 'accept' ? 'accepted' : 'delete';
  const row = database.prepare(`
    SELECT id FROM contacts WHERE id = ? AND addressee_id = ? AND status = 'pending'
  `).get(contactId, userId);
  if (!row) throw httpError(404, 'Incoming contact request not found.');
  if (status === 'delete') {
    database.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
  } else {
    database.prepare('UPDATE contacts SET status = ? WHERE id = ?').run(status, contactId);
  }
  json(response, 200, { ok: true });
}

async function handleSignalMessage(webSocket, message, database) {
  if (!message || typeof message.type !== 'string') throw httpError(400, 'Invalid signaling message.');
  const userId = webSocket.userId;

  if (message.type === 'call:invite') {
    enforceSocketRateLimit(userId, 'call-invite', 10);
    const contactId = cleanText(message.contactId, 36, 36);
    const mode = message.mode === 'deaf-to-hearing' ? 'deaf-to-hearing' : 'deaf-to-deaf';
    const contact = database.prepare(`
      SELECT requester_id, addressee_id FROM contacts
      WHERE id = ? AND status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
    `).get(contactId, userId, userId);
    if (!contact) throw httpError(403, 'Calls are limited to accepted contacts.');
    const calleeId = otherParticipant(contact, userId);
    const busy = database.prepare(`
      SELECT id FROM calls WHERE status IN ('ringing', 'connecting', 'connected')
        AND (caller_id = ? OR callee_id = ? OR caller_id = ? OR callee_id = ?)
    `).get(userId, userId, calleeId, calleeId);
    if (busy) throw httpError(409, 'One of the participants is already in a call.');

    const callId = randomUUID();
    const now = Date.now();
    database.prepare(`
      INSERT INTO calls(id, caller_id, callee_id, mode, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(callId, userId, calleeId, mode, 'ringing', now);
    send(webSocket, { type: 'call:outgoing', callId, contactId, mode, status: 'ringing', createdAt: now });
    const caller = getPublicUser(database, userId);
    if (!sendToUser(calleeId, {
      type: 'call:incoming',
      callId,
      mode,
      caller
    })) {
      database.prepare('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?')
        .run('missed', Date.now(), callId);
      send(webSocket, { type: 'call:state', callId, status: 'missed' });
    }
    return;
  }

  if (message.type === 'call:accept' || message.type === 'call:decline') {
    const call = getCallForParticipant(database, message.callId, userId);
    if (call.callee_id !== userId || call.status !== 'ringing') {
      throw httpError(403, 'This call invitation is no longer available.');
    }
    const status = message.type === 'call:accept' ? 'connecting' : 'declined';
    database.prepare('UPDATE calls SET status = ?, answered_at = ? WHERE id = ?')
      .run(status, status === 'connecting' ? Date.now() : null, call.id);
    sendToUser(call.caller_id, {
      type: message.type === 'call:accept' ? 'call:accepted' : 'call:declined',
      callId: call.id,
      mode: call.mode,
      peer: getPublicUser(database, userId)
    });
    send(webSocket, { type: 'call:state', callId: call.id, status });
    return;
  }

  if (message.type === 'call:cancel' || message.type === 'call:end') {
    const call = getCallForParticipant(database, message.callId, userId);
    finishCall(database, call, userId, message.type === 'call:cancel' ? 'missed' : 'ended');
    return;
  }

  if (message.type === 'call:ready') {
    const call = getCallForParticipant(database, message.callId, userId);
    if (!['connecting', 'connected'].includes(call.status)) {
      throw httpError(409, 'This call is not connecting.');
    }
    database.prepare('UPDATE calls SET status = ? WHERE id = ?').run('connected', call.id);
    const state = { type: 'call:state', callId: call.id, status: 'connected' };
    sendToUser(call.caller_id, state);
    sendToUser(call.callee_id, state);
    return;
  }

  if (message.type === 'webrtc:offer' || message.type === 'webrtc:answer' || message.type === 'webrtc:ice'
    || message.type === 'caption' || message.type === 'chat:message' || message.type.startsWith('recording:')) {
    const call = getCallForParticipant(database, message.callId, userId);
    if (!['ringing', 'connecting', 'connected'].includes(call.status)) {
      throw httpError(409, 'This call is no longer active.');
    }
    if (message.type === 'caption' || message.type === 'chat:message') {
      const text = cleanText(message.text, 1, 1000);
      if (!text) throw httpError(400, 'Message text is invalid.');
      message = {
        type: message.type,
        callId: call.id,
        text,
        ...(message.type === 'caption' ? { source: message.source === 'speech' ? 'speech' : 'sign' } : {}),
        createdAt: Date.now()
      };
    } else if (message.type.startsWith('recording:')) {
      if (call.status !== 'connected') throw httpError(409, 'Recording consent is available only in a connected call.');
      if (message.type === 'recording:request') {
        message = { type: message.type, callId: call.id, requesterId: userId, createdAt: Date.now() };
      } else if (message.type === 'recording:consent'
        && ['accepted', 'declined', 'withdrawn'].includes(message.consent)) {
        message = {
          type: message.type,
          callId: call.id,
          userId,
          consent: message.consent,
          createdAt: Date.now()
        };
      } else {
        throw httpError(400, 'Invalid recording consent action.');
      }
    } else {
      message = sanitizeSignalPayload(message, call.id);
    }
    const recipientId = otherParticipant(call, userId);
    if (!sendToUser(recipientId, { ...message, senderId: userId })) {
      send(webSocket, { type: 'call:reconnecting', callId: call.id, participantId: recipientId });
      return;
    }
    return;
  }

  throw httpError(400, 'Unsupported signaling message.');
}

function sanitizeSignalPayload(message, callId) {
  if (message.type === 'webrtc:ice') {
    const candidate = message.candidate;
    if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) {
      throw httpError(400, 'Invalid ICE candidate.');
    }
    return {
      type: message.type,
      callId,
      candidate: {
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid.slice(0, 128) : null,
        sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
        usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment.slice(0, 128) : null
      }
    };
  }
  const description = message.description;
  if (!description || !['offer', 'answer'].includes(description.type)
    || typeof description.sdp !== 'string' || description.sdp.length > 64 * 1024) {
    throw httpError(400, 'Invalid WebRTC session description.');
  }
  return { type: message.type, callId, description };
}

function finishCall(database, call, userId, status) {
  if (!['ended', 'missed'].includes(status)) return;
  const now = Date.now();
  database.prepare('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?').run(status, now, call.id);
  const otherId = otherParticipant(call, userId);
  sendToUser(otherId, { type: 'call:ended', callId: call.id, status, endedBy: userId });
  sendToUser(userId, { type: 'call:state', callId: call.id, status });
}

function getCallForParticipant(database, callId, userId) {
  if (typeof callId !== 'string' || callId.length > 64) throw httpError(400, 'Call identifier is invalid.');
  const call = database.prepare(`
    SELECT id, caller_id, callee_id, mode, status FROM calls
    WHERE id = ? AND (caller_id = ? OR callee_id = ?)
  `).get(callId, userId, userId);
  if (!call) throw httpError(404, 'Call not found.');
  return call;
}

function listContacts(database, userId) {
  return database.prepare(`
    SELECT c.id, c.status, c.created_at, c.requester_id, c.addressee_id,
           CASE WHEN c.requester_id = ? THEN other.id ELSE requester.id END AS user_id,
           CASE WHEN c.requester_id = ? THEN other.display_name ELSE requester.display_name END AS display_name,
           CASE WHEN c.requester_id = ? THEN other.email ELSE requester.email END AS email,
           CASE WHEN c.requester_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction
    FROM contacts c
    JOIN users requester ON requester.id = c.requester_id
    JOIN users other ON other.id = c.addressee_id
    WHERE c.requester_id = ? OR c.addressee_id = ?
    ORDER BY c.created_at DESC
  `).all(userId, userId, userId, userId, userId, userId);
}

function requireUser(request, response, database) {
  const user = findUserFromSession(request, database);
  if (!user) {
    json(response, 401, { error: 'Sign in is required.' });
    return null;
  }
  return user;
}

function findUserFromSession(request, database) {
  const token = getCookie(request, 'ss_session');
  if (!token) return null;
  const now = Date.now();
  const session = database.prepare(`
    SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?
  `).get(hashToken(token), now);
  return session ? getPublicUser(database, session.user_id) : null;
}

function getPublicUser(database, userId) {
  return database.prepare(`
    SELECT id, email, display_name AS displayName, email_verified_at AS emailVerifiedAt
    FROM users WHERE id = ?
  `).get(userId) || null;
}

function getSettings(database, userId) {
  const row = database.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(userId);
  if (!row) return {};
  try {
    return JSON.parse(row.settings_json);
  } catch {
    throw new Error('Stored account settings are invalid.');
  }
}

function expireOldRecords(database) {
  const now = Date.now();
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  database.prepare('DELETE FROM email_verifications WHERE expires_at <= ?').run(now);
  database.prepare('DELETE FROM recordings WHERE expires_at <= ?').run(now);
  database.prepare(`
    UPDATE calls SET status = 'missed', ended_at = ?
    WHERE status = 'ringing' AND created_at <= ?
  `).run(now, now - CALL_RING_TTL_MS);
}

function otherParticipant(call, userId) {
  return call.requester_id && call.addressee_id
    ? (call.requester_id === userId ? call.addressee_id : call.requester_id)
    : (call.caller_id === userId ? call.callee_id : call.caller_id);
}

function runTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    operation();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function sendToUser(userId, message) {
  const userSockets = socketsByUser.get(userId);
  if (!userSockets?.size) return false;
  const payload = JSON.stringify(message);
  for (const webSocket of userSockets) {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(payload);
  }
  return true;
}

function send(webSocket, message) {
  if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Request body must be valid JSON.');
  }
}

function enforceRateLimit(request, route, limit, userId = '') {
  const identity = userId || request.socket.remoteAddress || 'unknown';
  enforceBucket(`${route}:${identity}`, limit);
}

function enforceSocketRateLimit(userId, route, limit) {
  enforceBucket(`${route}:${userId}`, limit);
}

function enforceBucket(key, limit) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt > 60_000) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > limit) throw httpError(429, 'Too many requests. Try again shortly.');
  if (rateBuckets.size > 4000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (now - value.startedAt > 60_000) rateBuckets.delete(bucketKey);
    }
  }
}

function validateOrigin(request, isTls) {
  const origin = request.headers.origin;
  if (!origin) return;
  const forwardedProtocol = process.env.TRUST_PROXY === '1'
    ? request.headers['x-forwarded-proto']?.split(',')[0]
    : null;
  const protocol = forwardedProtocol || (isTls || request.socket.encrypted ? 'https' : 'http');
  const expectedOrigin = process.env.PUBLIC_ORIGIN || `${protocol}://${request.headers.host}`;
  if (origin !== expectedOrigin) throw httpError(403, 'Cross-origin requests are not allowed.');
}

function sessionCookie(token, expiresAt, isTls) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `ss_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isTls || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function clearSessionCookie(response, isTls) {
  response.setHeader('Set-Cookie', `ss_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isTls || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function getCookie(request, name) {
  const cookieHeader = request.headers.cookie || '';
  for (const segment of cookieHeader.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function cleanText(value, minLength, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length >= minLength && text.length <= maxLength ? text : '';
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export { db as database } from './db.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const application = createSignSpeakServer();
  application.listen().then(({ address, port }) => {
    console.log(`SignSpeak backend listening at ${process.env.PUBLIC_ORIGIN || `http://${address}:${port}`}`);
  }).catch((error) => {
    console.error('Failed to start SignSpeak backend:', error);
    process.exitCode = 1;
  });

  const shutdown = () => {
    application.close().then(() => process.exit(0)).catch((error) => {
      console.error('Failed to stop SignSpeak backend:', error);
      process.exit(1);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
