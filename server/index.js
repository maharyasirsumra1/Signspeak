import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { db as defaultDatabase } from './db.js';
import {
  bootstrapSuperAdmin,
  handleAdminRequest,
  recordAuthEvent,
  recordUserActivity
} from './admin.js';
import { verifyFacebookAccessToken } from './facebook-auth.js';
import { verifyGoogleIdToken } from './google-auth.js';
import { sendVerificationEmail } from './mailer.js';
import { issuePasswordReset } from './password-reset.js';
import { createToken, hashPassword, hashToken, verifyPassword } from './security.js';
import { cleanProfileImageUrl } from './validation.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 30 * 60 * 1000;
const CALL_RING_TTL_MS = 45 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const TELEMETRY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const rateBuckets = new Map();
const socketsByUser = new Map();
let lastTelemetryPruneAt = 0;

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
  bootstrapSuperAdmin(database, process.env.SUPER_ADMIN_EMAIL);
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
        webSocket.sessionId = database.prepare(
          'SELECT session_id FROM sessions WHERE token_hash = ?'
        ).get(hashToken(getCookie(request, 'ss_session')))?.session_id;
        webSocket.ipAddress = request.socket.remoteAddress || null;
        webSocket.userAgent = request.headers['user-agent'] || null;
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
      if (userSockets.size > 0) return;
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
      {
        googleClientId,
        googleTokenVerifier,
        facebookAppId,
        facebookAppSecret,
        facebookTokenVerifier
      }
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
  const forwardedProtocol = process.env.TRUST_PROXY === '1'
    ? request.headers['x-forwarded-proto']?.split(',')[0]
    : null;
  const protocol = forwardedProtocol || (isTls ? 'https' : 'http');
  const url = new URL(request.url, `${protocol}://${request.headers.host || 'localhost'}`);
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
  if (method === 'POST' && pathname === '/api/auth/password-reset/request') {
    enforceRateLimit(request, 'password-reset-request', 5);
    await requestPasswordReset(request, response, database, url);
    return;
  }
  if (method === 'GET' && pathname === '/api/auth/verify') {
    verifyEmail(request, response, database, url, isTls);
    return;
  }
  if (method === 'POST' && pathname === '/api/auth/password-reset/complete') {
    enforceRateLimit(request, 'password-reset-complete', 10);
    await completePasswordReset(request, response, database, isTls);
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
    if (sessionToken) {
      const session = database.prepare(`
        SELECT user_id, session_id FROM sessions
        WHERE token_hash = ? AND revoked_at IS NULL
      `).get(hashToken(sessionToken));
      if (session) {
        const now = Date.now();
        recordAuthEvent(database, request, 'logout', { userId: session.user_id });
        database.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?')
          .run(now, hashToken(sessionToken));
        database.prepare('UPDATE users SET last_logout_at = ? WHERE id = ?').run(now, session.user_id);
        closeUserSockets(session.user_id, session.session_id);
      }
    }
    clearSessionCookie(response, isTls);
    json(response, 200, { ok: true });
    return;
  }

  if (pathname.startsWith('/api/admin/')) {
    const adminUser = requireUser(request, response, database);
    if (!adminUser) return;
    if (method !== 'GET' && method !== 'HEAD') {
      enforceRateLimit(request, 'admin-mutation', 60, adminUser.id);
    }
    const handled = await handleAdminRequest(
      request,
      response,
      database,
      adminUser,
      url,
      {
        closeUserSockets,
        getConnectionInfo,
        terminateUserCalls: (userId) => terminateUserCalls(database, userId)
      }
    );
    if (!handled) json(response, 404, { error: 'Route not found.' });
    return;
  }

  const user = requireUser(request, response, database);
  if (!user) return;

  if (method === 'POST' && pathname === '/api/activity') {
    enforceRateLimit(request, 'user-activity', 120, user.id);
    const body = await readJson(request);
    recordUserActivity(database, request, user.id, body.action);
    json(response, 202, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/profile') {
    json(response, 200, { user, settings: getSettings(database, user.id) });
    return;
  }
  if (method === 'PATCH' && pathname === '/api/profile') {
    const body = await readJson(request);
    const displayName = cleanText(body.displayName, 2, 80);
    if (!displayName) throw httpError(400, 'Display name must be between 2 and 80 characters.');
    let profileImageUrl = user.profileImageUrl;
    if (body.profileImageUrl !== undefined) {
      try {
        profileImageUrl = cleanProfileImageUrl(body.profileImageUrl);
      } catch (error) {
        throw httpError(400, error.message);
      }
    }
    database.prepare(`
      UPDATE users SET display_name = ?, profile_image_url = ? WHERE id = ?
    `).run(displayName, profileImageUrl, user.id);
    recordUserActivity(database, request, user.id, 'profile_updated');
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
    json(response, 200, {
      contacts: listContacts(database, user.id),
      callingEnabled: hasEnabledCallDevice(database, user.id)
    });
    return;
  }
  if (method === 'POST' && pathname === '/api/contacts') {
    throw httpError(403, 'Calling contacts can only be approved by a Super Admin.');
  }
  const contactAction = pathname.match(/^\/api\/contacts\/([0-9a-f-]{36})\/(accept|decline)$/i);
  if (method === 'POST' && contactAction) {
    throw httpError(403, 'Calling contacts can only be managed by a Super Admin.');
  }
  const contactDelete = pathname.match(/^\/api\/contacts\/([0-9a-f-]{36})$/i);
  if (method === 'DELETE' && contactDelete) {
    throw httpError(403, 'Calling contacts can only be managed by a Super Admin.');
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
    recordAuthEvent(database, request, 'account_deleted', { userId: user.id, email: user.email });
    recordUserActivity(database, request, user.id, 'account_deleted');
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
  const requestedUsername = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const displayName = cleanText(body.displayName, 2, 80);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw httpError(400, 'Enter a valid email address.');
  }
  if (body.username !== undefined && !/^[a-z0-9._-]{3,32}$/.test(requestedUsername)) {
    throw httpError(400, 'Username must be 3 to 32 characters and contain only letters, numbers, dots, underscores, or hyphens.');
  }
  if (!displayName) throw httpError(400, 'Display name must be between 2 and 80 characters.');
  if (password.length < 6 || password.length > 128) {
    throw httpError(400, 'Password must be between 6 and 128 characters.');
  }
  if (database.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    throw httpError(409, 'An account with this email already exists.');
  }

  const userId = randomUUID();
  const username = requestedUsername || makeAvailableUsername(database, email.split('@')[0], userId);
  if (database.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    throw httpError(409, 'This username is already taken.');
  }
  const token = createToken();
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  const insertUser = database.prepare(`
    INSERT INTO users(id, email, username, display_name, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertVerification = database.prepare(`
    INSERT INTO email_verifications(token_hash, user_id, expires_at) VALUES (?, ?, ?)
  `);
  try {
    runTransaction(database, () => {
      insertUser.run(userId, email, username, displayName, passwordHash, now);
      insertVerification.run(hashToken(token), userId, now + VERIFY_TTL_MS);
    });
  } catch (error) {
    if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
      throw httpError(409, 'This email address or username is already in use.');
    }
    throw error;
  }

  const origin = process.env.PUBLIC_ORIGIN || requestUrl.origin;
  const verificationUrl = new URL('/', origin);
  verificationUrl.searchParams.set('verify', token);
  try {
    const mailResult = await sendVerificationEmail({
      email,
      displayName,
      verificationUrl: verificationUrl.toString()
    });
    recordAuthEvent(database, request, 'registration', { userId, email });
    json(response, 201, {
      message: 'Account created. You can now sign in with your email and password.',
      ...(mailResult.developmentUrl ? { developmentVerificationUrl: mailResult.developmentUrl } : {})
    });
  } catch (error) {
    database.prepare('DELETE FROM users WHERE id = ?').run(userId);
    throw httpError(503, error.message);
  }
}

async function resendVerification(request, response, database, requestUrl) {
  const body = await readJson(request);
  const identifier = typeof (body?.identifier ?? body?.email) === 'string'
    ? String(body.identifier ?? body.email).trim().toLowerCase()
    : '';
  if (!identifier || identifier.length > 254) {
    throw httpError(400, 'Enter your email address or username.');
  }

  const user = database.prepare(`
    SELECT id, email, display_name, email_verified_at FROM users
    WHERE email = ? OR username = ?
  `).get(identifier, identifier);
  const message = 'If an unverified account exists for this email or username, a verification link has been sent.';
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

function verifyEmail(request, response, database, url, isTls) {
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
  recordAuthEvent(database, request, 'email_verified', { userId: verification.user_id });
  const user = establishSession(request, response, database, verification.user_id, isTls);
  json(response, 200, { message: 'Email verified. You are now signed in.', user });
}

async function requestPasswordReset(request, response, database, url) {
  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const user = email.length <= 254
    ? database.prepare(`
      SELECT id, email, display_name
      FROM users
      WHERE email = ? AND email_verified_at IS NOT NULL AND account_status = 'active'
    `).get(email)
    : null;

  let developmentResetUrl = '';
  if (user) {
    try {
      const mailResult = await issuePasswordReset(database, {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        origin: process.env.PUBLIC_ORIGIN || url.origin
      });
      developmentResetUrl = mailResult.developmentUrl || '';
      recordAuthEvent(database, request, 'password_reset_requested', { userId: user.id });
    } catch (error) {
      console.error('Unable to deliver password reset instructions:', error);
    }
  }

  json(response, 200, {
    message: 'If an active, verified account exists for this email, password reset instructions have been sent.',
    ...(developmentResetUrl ? { developmentResetUrl } : {})
  });
}

async function completePasswordReset(request, response, database, isTls) {
  const body = await readJson(request);
  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (token.length < 32 || token.length > 128) {
    throw httpError(400, 'Password reset link is invalid or expired.');
  }
  if (password.length < 6 || password.length > 128) {
    throw httpError(400, 'Password must be between 6 and 128 characters.');
  }

  const passwordHash = await hashPassword(password);
  const now = Date.now();
  let userId;
  runTransaction(database, () => {
    const reset = database.prepare(`
      SELECT user_id FROM password_reset_tokens
      WHERE token_hash = ? AND expires_at > ?
    `).get(hashToken(token), now);
    if (!reset) throw httpError(400, 'Password reset link is invalid or expired.');

    userId = reset.user_id;
    database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    database.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
    database.prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(now, userId);
  });

  closeUserSockets(userId);
  recordAuthEvent(database, request, 'password_reset', { userId });
  clearSessionCookie(response, isTls);
  json(response, 200, { message: 'Password updated. Sign in with your new password.' });
}

async function login(request, response, database, isTls) {
  const body = await readJson(request);
  const identifier = typeof (body.identifier ?? body.email) === 'string'
    ? String(body.identifier ?? body.email).trim().toLowerCase()
    : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = database.prepare('SELECT * FROM users WHERE email = ? OR username = ?')
    .get(identifier, identifier);
  const validPassword = user && await verifyPassword(password, user.password_hash);
  if (!validPassword) {
    recordAuthEvent(database, request, 'login_failed', {
      userId: user?.id || null,
      email: user?.email || identifier,
      details: { reason: 'invalid_credentials' }
    });
    throw httpError(401, 'Email, username or password is incorrect.');
  }
  if (user.account_status !== 'active') {
    recordAuthEvent(database, request, 'login_failed', {
      userId: user.id,
      email: user.email,
      details: { reason: user.account_status }
    });
    throw httpError(403, 'This account is not active. Contact SignSpeak support.');
  }
  createSession(request, response, database, user.id, isTls);
}

async function loginWithGoogle(request, response, database, isTls, clientId, tokenVerifier) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || typeof body.credential !== 'string') {
    throw httpError(400, 'Google sign-in credential is required.');
  }

  const identity = await tokenVerifier(body.credential, clientId);
  await loginWithExternalIdentity(request, response, database, isTls, 'google', identity);
}

async function loginWithFacebook(request, response, database, isTls, appId, appSecret, tokenVerifier) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || typeof body.accessToken !== 'string') {
    throw httpError(400, 'Facebook sign-in token is required.');
  }
  const identity = await tokenVerifier(body.accessToken, appId, appSecret);
  await loginWithExternalIdentity(request, response, database, isTls, 'facebook', identity);
}

async function loginWithExternalIdentity(request, response, database, isTls, provider, identity) {
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
  const existingEmail = database.prepare('SELECT id, account_status FROM users WHERE email = ?').get(normalizedEmail);
  const linkedUserId = linkedIdentity?.user_id || existingEmail?.id;
  const linkedUserStatus = linkedUserId
    ? database.prepare('SELECT account_status FROM users WHERE id = ?').get(linkedUserId)?.account_status
    : null;
  if (linkedUserStatus && linkedUserStatus !== 'active') {
    recordAuthEvent(database, request, 'login_failed', {
      userId: linkedUserId,
      email: normalizedEmail,
      details: { reason: linkedUserStatus, provider }
    });
    throw httpError(403, 'This account is not active. Contact SignSpeak support.');
  }
  const passwordHash = !linkedIdentity && !existingEmail
    ? await hashPassword(createToken())
    : null;
  const now = Date.now();
  let userId = linkedIdentity?.user_id || null;
  let createdUser = false;

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
          const username = makeAvailableUsername(database, localPart, userId);
          database.prepare(`
            INSERT INTO users(id, email, username, display_name, password_hash, email_verified_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(userId, normalizedEmail, username, displayName, passwordHash, now, now);
          createdUser = true;
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

  const account = database.prepare('SELECT account_status FROM users WHERE id = ?').get(userId);
  if (account?.account_status !== 'active') {
    recordAuthEvent(database, request, 'login_failed', {
      userId,
      email: normalizedEmail,
      details: { reason: account?.account_status || 'account_not_found', provider }
    });
    throw httpError(403, 'This account is not active. Contact SignSpeak support.');
  }
  if (createdUser) recordAuthEvent(database, request, 'registration', { userId, email: normalizedEmail, details: { provider } });
  createSession(request, response, database, userId, isTls, provider);
}

function createSession(request, response, database, userId, isTls, method = 'password') {
  const user = establishSession(request, response, database, userId, isTls, method);
  json(response, 200, { user });
}

function establishSession(request, response, database, userId, isTls, method = 'email_verification') {
  const token = createToken();
  const sessionId = randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  const userAgent = typeof request.headers['user-agent'] === 'string'
    ? request.headers['user-agent'].slice(0, 512)
    : null;
  const ipAddress = request.socket.remoteAddress || null;
  runTransaction(database, () => {
    database.prepare(`
      INSERT INTO sessions(
        session_id, token_hash, user_id, created_at, expires_at,
        last_seen_at, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, hashToken(token), userId, createdAt, expiresAt, createdAt, ipAddress, userAgent);
    database.prepare(`
      UPDATE users SET last_login_at = ?, last_active_at = ?,
        successful_login_count = successful_login_count + 1
      WHERE id = ?
    `).run(createdAt, createdAt, userId);
    recordAuthEvent(database, request, 'login_success', { userId, details: { method } });
    recordAuthEvent(database, request, 'session_created', { userId, details: { sessionId } });
  });
  response.setHeader('Set-Cookie', sessionCookie(token, expiresAt, isTls));
  return getPublicUser(database, userId);
}

async function handleSignalMessage(webSocket, message, database) {
  if (!message || typeof message.type !== 'string') throw httpError(400, 'Invalid signaling message.');
  const userId = webSocket.userId;

  if (message.type === 'call:invite') {
    enforceSocketRateLimit(userId, 'call-invite', 10);
    const calleeId = cleanText(message.contactId, 36, 36);
    const mode = message.mode === 'deaf-to-hearing' ? 'deaf-to-hearing' : 'deaf-to-deaf';
    if (!hasEnabledCallDevice(database, userId)) {
      throw httpError(403, 'Calling is not enabled for this account. Contact the SignSpeak Super Admin.');
    }
    if (
      !calleeId
      || calleeId === userId
      || !hasEnabledCallDevice(database, calleeId)
      || !database.prepare(`
        SELECT id FROM users WHERE id = ? AND account_status = 'active' AND email_verified_at IS NOT NULL
      `).get(calleeId)
    ) {
      throw httpError(403, 'This account is not an approved SignSpeak calling contact.');
    }
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
    recordUserActivity(database, {
      socket: { remoteAddress: webSocket.ipAddress },
      headers: { 'user-agent': webSocket.userAgent }
    }, userId, 'call_initiated');
    send(webSocket, { type: 'call:outgoing', callId, contactId: calleeId, mode, status: 'ringing', createdAt: now });
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
    if (message.type === 'call:accept'
      && (!hasEnabledCallDevice(database, call.caller_id) || !hasEnabledCallDevice(database, call.callee_id))) {
      finishCall(database, call, userId, 'interrupted');
      throw httpError(403, 'Calling permission has been disabled for this account.');
    }
    const status = message.type === 'call:accept' ? 'connecting' : 'declined';
    database.prepare('UPDATE calls SET status = ?, answered_at = ? WHERE id = ?')
      .run(status, status === 'connecting' ? Date.now() : null, call.id);
    if (message.type === 'call:accept') {
      notifyOtherUserDevices(userId, webSocket, {
        type: 'call:claimed',
        callId: call.id,
        status
      });
    } else {
      notifyOtherUserDevices(userId, webSocket, {
        type: 'call:state',
        callId: call.id,
        status
      });
    }
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
    recordUserActivity(database, {
      socket: { remoteAddress: webSocket.ipAddress },
      headers: { 'user-agent': webSocket.userAgent }
    }, userId, 'call_ended');
    return;
  }

  if (message.type === 'call:ready') {
    const call = getCallForParticipant(database, message.callId, userId);
    if (!['connecting', 'connected'].includes(call.status)) {
      throw httpError(409, 'This call is not connecting.');
    }
    if (!hasEnabledCallDevice(database, call.caller_id) || !hasEnabledCallDevice(database, call.callee_id)) {
      finishCall(database, call, userId, 'interrupted');
      return;
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
    if (!hasEnabledCallDevice(database, call.caller_id) || !hasEnabledCallDevice(database, call.callee_id)) {
      finishCall(database, call, userId, 'interrupted');
      return;
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
  if (!['ended', 'missed', 'interrupted'].includes(status)) return;
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
  if (!hasEnabledCallDevice(database, userId)) return [];
  return database.prepare(`
    SELECT u.id, u.id AS user_id, 'accepted' AS status,
      NULL AS created_at, u.display_name, u.email,
      'approved' AS direction,
      COUNT(d.id) AS registered_devices
    FROM users u
    JOIN approved_call_devices d ON d.user_id = u.id
    WHERE u.id <> ? AND u.account_status = 'active' AND u.email_verified_at IS NOT NULL
      AND d.phone_verified_at IS NOT NULL AND d.calls_enabled = 1
    GROUP BY u.id
    ORDER BY u.display_name COLLATE NOCASE
  `).all(userId).map((contact) => ({
    ...contact,
    online: Boolean(socketsByUser.get(contact.user_id)?.size)
  }));
}

function hasEnabledCallDevice(database, userId) {
  return Boolean(database.prepare(`
    SELECT 1 FROM approved_call_devices
    WHERE user_id = ? AND phone_verified_at IS NOT NULL AND calls_enabled = 1
  `).get(userId));
}

function requireUser(request, response, database) {
  const user = findUserFromSession(request, database);
  if (!user) {
    json(response, 401, { error: 'Sign in is required.' });
    return null;
  }
  const sessionToken = getCookie(request, 'ss_session');
  const now = Date.now();
  database.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    .run(now, hashToken(sessionToken));
  database.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(now, user.id);
  return user;
}

function findUserFromSession(request, database) {
  const token = getCookie(request, 'ss_session');
  if (!token) return null;
  const now = Date.now();
  const session = database.prepare(`
    SELECT s.user_id FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
      AND s.revoked_at IS NULL AND u.account_status = 'active'
  `).get(hashToken(token), now);
  return session ? getPublicUser(database, session.user_id) : null;
}

function getPublicUser(database, userId) {
  return database.prepare(`
    SELECT id, email, username, display_name AS displayName, profile_image_url AS profileImageUrl,
      email_verified_at AS emailVerifiedAt, role, account_status AS accountStatus
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
  database.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?').run(now);
  database.prepare('DELETE FROM recordings WHERE expires_at <= ?').run(now);
  if (now - lastTelemetryPruneAt >= 24 * 60 * 60 * 1000) {
    const cutoff = now - TELEMETRY_RETENTION_MS;
    database.prepare('DELETE FROM auth_events WHERE created_at <= ?').run(cutoff);
    database.prepare('DELETE FROM user_activity WHERE created_at <= ?').run(cutoff);
    lastTelemetryPruneAt = now;
  }
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
  let sent = false;
  for (const webSocket of userSockets) {
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(payload);
      sent = true;
    }
  }
  return sent;
}

function notifyOtherUserDevices(userId, excludedSocket, message) {
  const userSockets = socketsByUser.get(userId);
  if (!userSockets?.size) return;
  for (const webSocket of userSockets) {
    if (webSocket !== excludedSocket) send(webSocket, message);
  }
}

function getConnectionInfo(userId) {
  const sockets = [...(socketsByUser.get(userId) || [])]
    .filter((webSocket) => webSocket.readyState === WebSocket.OPEN);
  const isMobile = (webSocket) => /android|iphone|ipad|ipod|mobile/i.test(webSocket.userAgent || '');
  return {
    online: sockets.length > 0,
    connectedSessions: sockets.length,
    mobileConnected: sockets.some(isMobile),
    desktopConnected: sockets.some((webSocket) => !isMobile(webSocket))
  };
}

function terminateUserCalls(database, userId) {
  const calls = database.prepare(`
    SELECT id, caller_id, callee_id FROM calls
    WHERE status IN ('ringing', 'connecting', 'connected')
      AND (caller_id = ? OR callee_id = ?)
  `).all(userId, userId);
  for (const call of calls) finishCall(database, call, userId, 'interrupted');
}

function closeUserSockets(userId, sessionId = null) {
  const userSockets = socketsByUser.get(userId);
  if (!userSockets) return;
  for (const webSocket of userSockets) {
    if (!sessionId || webSocket.sessionId === sessionId) {
      webSocket.close(4001, 'SignSpeak session revoked');
    }
  }
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

function makeAvailableUsername(database, preferredUsername, userId) {
  const base = preferredUsername.toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 32);
  const safeBase = base.length >= 3 ? base : 'user';
  let candidate = safeBase;
  let sequence = 1;
  while (database.prepare('SELECT id FROM users WHERE username = ?').get(candidate)) {
    const suffix = `-${userId.replace(/-/g, '').slice(0, 5)}${sequence > 1 ? sequence : ''}`;
    candidate = `${safeBase.slice(0, 32 - suffix.length)}${suffix}`;
    sequence += 1;
  }
  return candidate;
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
