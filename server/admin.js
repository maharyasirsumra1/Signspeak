import { randomUUID } from 'node:crypto';
import { sendVerificationEmail } from './mailer.js';
import { issuePasswordReset } from './password-reset.js';
import { createToken, hashPassword, hashToken, verifyPassword } from './security.js';
import { cleanProfileImageUrl } from './validation.js';

const PERMISSIONS = [
  { key: 'admin.access', label: 'Access admin panel' },
  { key: 'users.read', label: 'View users' },
  { key: 'users.manage', label: 'Manage user accounts' },
  { key: 'sessions.read', label: 'View active sessions' },
  { key: 'sessions.revoke', label: 'Revoke user sessions' },
  { key: 'logs.auth.read', label: 'View authentication history' },
  { key: 'logs.activity.read', label: 'View user activity' },
  { key: 'audit.read', label: 'View admin audit history' },
  { key: 'reports.read', label: 'View reports and analytics' }
];
const PERMISSION_KEYS = new Set(PERMISSIONS.map(({ key }) => key));
const ACTIVITY_ACTIONS = new Map([
  ['app_access', 'Opened SignSpeak'],
  ['recognition_started', 'Started sign recognition'],
  ['recognition_stopped', 'Stopped sign recognition'],
  ['screenshot_created', 'Created a subtitle screenshot'],
  ['text_exported', 'Exported subtitle text'],
  ['sentence_action', 'Used a sentence builder action'],
  ['dataset_studio_used', 'Used Dataset Studio'],
  ['contact_request_sent', 'Sent a contact request'],
  ['contact_request_accepted', 'Accepted a contact request'],
  ['call_initiated', 'Initiated a call'],
  ['call_ended', 'Ended a call'],
  ['profile_updated', 'Updated account profile'],
  ['account_deleted', 'Deleted their account']
]);
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;

export function bootstrapSuperAdmin(database, configuredEmail) {
  if (!configuredEmail) return;
  const email = configuredEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('SUPER_ADMIN_EMAIL must be a valid email address.');
  }
  const user = database.prepare(`
    SELECT id, role, email_verified_at FROM users WHERE email = ?
  `).get(email);
  if (!user || !user.email_verified_at) {
    throw new Error('SUPER_ADMIN_EMAIL must match an existing, verified SignSpeak account.');
  }
  if (user.role === 'super_admin') return;

  const now = Date.now();
  runTransaction(database, () => {
    database.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(user.id);
    writeAudit(database, user.id, user.id, 'super_admin_bootstrapped', { role: user.role }, { role: 'super_admin' }, now);
  });
}

export function recordAuthEvent(database, request, eventType, { userId = null, email = null, details = {} } = {}) {
  const { ipAddress, userAgent } = requestMetadata(request);
  database.prepare(`
    INSERT INTO auth_events(id, user_id, email, event_type, ip_address, user_agent, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    userId,
    cleanOptionalText(email, 254),
    eventType,
    ipAddress,
    userAgent,
    JSON.stringify(details),
    Date.now()
  );
}

export function recordUserActivity(database, request, userId, action) {
  const summary = ACTIVITY_ACTIONS.get(action);
  if (!summary) throw httpError(400, 'Unsupported activity action.');
  const { ipAddress, userAgent } = requestMetadata(request);
  database.prepare(`
    INSERT INTO user_activity(
      id, actor_user_id, subject_user_id, action, summary, ip_address, user_agent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, userId, action, summary, ipAddress, userAgent, Date.now());
}

export async function handleAdminRequest(request, response, database, user, url, controls = {}) {
  const { pathname } = url;
  const method = request.method || 'GET';
  if (!pathname.startsWith('/api/admin/')) return false;

  if (!['admin', 'super_admin'].includes(user.role)) {
    writeAudit(database, user.id, null, 'admin_access_denied', {}, {}, Date.now(), 'failure');
    throw httpError(403, 'Administrator access is required.');
  }
  requirePermission(database, user, 'admin.access', pathname);

  if (method === 'GET' && pathname === '/api/admin/dashboard') {
    requirePermission(database, user, 'reports.read', pathname);
    json(response, 200, { dashboard: getDashboard(database) });
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/profile') {
    json(response, 200, { profile: getAdminProfile(database, user) });
    return true;
  }
  if (method === 'PATCH' && pathname === '/api/admin/profile') {
    await updateAdminProfile(request, response, database, user, url, controls);
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/contacts') {
    requirePermission(database, user, 'users.read', pathname);
    json(response, 200, listAdminContacts(database, url));
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/call-devices') {
    requireSuperAdmin(database, user, pathname);
    json(response, 200, listCallDevices(database, controls.getConnectionInfo));
    return true;
  }
  if (method === 'POST' && pathname === '/api/admin/call-devices') {
    requireSuperAdmin(database, user, pathname);
    await createCallDevice(request, response, database, user, controls);
    return true;
  }
  const callDeviceAction = pathname.match(/^\/api\/admin\/call-devices\/([0-9a-f-]{36})$/i);
  if (callDeviceAction && method === 'PATCH') {
    requireSuperAdmin(database, user, pathname);
    await updateCallDevice(request, response, database, user, callDeviceAction[1], controls);
    return true;
  }
  if (callDeviceAction && method === 'DELETE') {
    requireSuperAdmin(database, user, pathname);
    removeCallDevice(response, database, user, callDeviceAction[1], controls);
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/calls') {
    requirePermission(database, user, 'reports.read', pathname);
    json(response, 200, listAdminCalls(database, url));
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/security') {
    requirePermission(database, user, 'reports.read', pathname);
    json(response, 200, { security: getSecuritySnapshot(database) });
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/system') {
    requirePermission(database, user, 'reports.read', pathname);
    json(response, 200, {
      system: {
        runtime: process.version,
        database: 'SQLite',
        eventRetentionDays: EVENT_RETENTION_MS / (24 * 60 * 60 * 1000),
        capturedAt: Date.now()
      }
    });
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/users') {
    requirePermission(database, user, 'users.read', pathname);
    json(response, 200, listUsers(database, url));
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/sessions') {
    requirePermission(database, user, 'sessions.read', pathname);
    json(response, 200, listSessions(database, url));
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/auth-events') {
    requirePermission(database, user, 'logs.auth.read', pathname);
    json(response, 200, listAuthEvents(database, url));
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/activity') {
    requirePermission(database, user, 'logs.activity.read', pathname);
    json(response, 200, listActivity(database, url));
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/audit-logs') {
    requirePermission(database, user, 'audit.read', pathname);
    json(response, 200, listAuditLogs(database, url));
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/permissions') {
    requireSuperAdmin(database, user, pathname);
    json(response, 200, { permissions: PERMISSIONS });
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/admins') {
    requireSuperAdmin(database, user, pathname);
    json(response, 200, { admins: listAdmins(database) });
    return true;
  }

  const roleAction = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/role$/i);
  if (method === 'PATCH' && roleAction) {
    requireSuperAdmin(database, user, pathname);
    await changeUserRole(request, response, database, user, roleAction[1]);
    return true;
  }

  const permissionAction = pathname.match(/^\/api\/admin\/admins\/([0-9a-f-]{36})\/permissions$/i);
  if (method === 'PUT' && permissionAction) {
    requireSuperAdmin(database, user, pathname);
    await replaceAdminPermissions(request, response, database, user, permissionAction[1]);
    return true;
  }

  const passwordResetAction = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/password-reset$/i);
  if (method === 'POST' && passwordResetAction) {
    requirePermission(database, user, 'users.manage', pathname);
    await sendUserPasswordReset(response, database, user, passwordResetAction[1], url);
    return true;
  }

  const userAction = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})(?:\/(restore|permanent))?$/i);
  if (userAction && method === 'GET' && !userAction[2]) {
    requirePermission(database, user, 'users.read', pathname);
    json(response, 200, { user: getUserDetails(database, userAction[1]) });
    return true;
  }
  if (userAction && method === 'PATCH' && !userAction[2]) {
    requirePermission(database, user, 'users.manage', pathname);
    await updateUser(request, response, database, user, userAction[1], controls);
    return true;
  }
  if (userAction && method === 'POST' && userAction[2] === 'restore') {
    requirePermission(database, user, 'users.manage', pathname);
    restoreUser(response, database, user, userAction[1]);
    return true;
  }
  if (userAction && method === 'DELETE' && !userAction[2]) {
    requirePermission(database, user, 'users.manage', pathname);
    softDeleteUser(response, database, user, userAction[1], controls);
    return true;
  }
  if (userAction && method === 'DELETE' && userAction[2] === 'permanent') {
    requireSuperAdmin(database, user, pathname);
    await permanentlyDeleteUser(request, response, database, user, userAction[1]);
    return true;
  }

  const revokeAction = pathname.match(/^\/api\/admin\/sessions\/([0-9a-f-]{36})\/revoke$/i);
  if (method === 'POST' && revokeAction) {
    requirePermission(database, user, 'sessions.revoke', pathname);
    revokeSession(response, database, user, revokeAction[1], controls);
    return true;
  }

  return false;
}

export function requireActiveAccount(database, userId) {
  const account = database.prepare('SELECT account_status FROM users WHERE id = ?').get(userId);
  return account?.account_status === 'active';
}

function getDashboard(database) {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const startToday = startOfToday.getTime();
  const counts = database.prepare(`
    SELECT
      COUNT(*) AS totalUsers,
      COALESCE(SUM(CASE WHEN email_verified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS verifiedUsers,
      COALESCE(SUM(CASE WHEN account_status = 'active' THEN 1 ELSE 0 END), 0) AS activeUsers,
      COALESCE(SUM(CASE WHEN account_status = 'suspended' THEN 1 ELSE 0 END), 0) AS suspendedUsers,
      COALESCE(SUM(CASE WHEN account_status = 'deleted' THEN 1 ELSE 0 END), 0) AS deletedUsers,
      COALESCE(SUM(CASE WHEN last_active_at >= ? AND account_status = 'active' THEN 1 ELSE 0 END), 0) AS onlineUsers,
      COALESCE(SUM(successful_login_count), 0) AS totalLogins
    FROM users
  `).get(now - 5 * 60 * 1000);
  const events = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN event_type = 'login_success' THEN 1 ELSE 0 END), 0) AS successfulLogins,
      COALESCE(SUM(CASE WHEN event_type = 'login_failed' THEN 1 ELSE 0 END), 0) AS failedLogins
    FROM auth_events
  `).get();
  events.registrationsToday = database.prepare(
    'SELECT COUNT(*) AS count FROM users WHERE created_at >= ?'
  ).get(startToday).count;
  events.registrationsWeek = database.prepare(
    'SELECT COUNT(*) AS count FROM users WHERE created_at >= ?'
  ).get(now - 7 * 24 * 60 * 60 * 1000).count;
  events.registrationsMonth = database.prepare(
    'SELECT COUNT(*) AS count FROM users WHERE created_at >= ?'
  ).get(now - 30 * 24 * 60 * 60 * 1000).count;
  const totals = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM contacts) AS contactRequests,
      (SELECT COUNT(*) FROM calls) AS callsInitiated,
      (SELECT COUNT(*) FROM user_activity WHERE action = 'recognition_started') AS recognitionSessions,
      (SELECT COUNT(*) FROM user_activity) AS activityEvents
  `).get();
  const registrations = database.prepare(`
    SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS total
    FROM users WHERE created_at >= ?
    GROUP BY day ORDER BY day
  `).all(now - 30 * 24 * 60 * 60 * 1000);
  const featureUsage = database.prepare(`
    SELECT action, COUNT(*) AS total
    FROM user_activity
    WHERE created_at >= ?
    GROUP BY action ORDER BY total DESC LIMIT 10
  `).all(now - 30 * 24 * 60 * 60 * 1000);

  return {
    users: counts,
    authentication: events,
    usage: totals,
    registrations,
    featureUsage
  };
}

function listUsers(database, url) {
  const { page, pageSize, offset } = pagination(url);
  const conditions = [];
  const values = [];
  const query = url.searchParams.get('q')?.trim().slice(0, 254);
  const status = url.searchParams.get('status');
  const role = url.searchParams.get('role');
  const from = parseDateFilter(url.searchParams.get('from'));
  const to = parseDateFilter(url.searchParams.get('to'));
  if (query) {
    conditions.push('(instr(lower(u.display_name), lower(?)) > 0 OR instr(lower(u.email), lower(?)) > 0 OR u.id = ?)');
    values.push(query, query, query);
  }
  if (status && ['active', 'suspended', 'deleted'].includes(status)) {
    conditions.push('u.account_status = ?');
    values.push(status);
  } else if (status && status !== 'all') {
    throw httpError(400, 'Invalid account status filter.');
  }
  if (role && ['user', 'admin', 'super_admin'].includes(role)) {
    conditions.push('u.role = ?');
    values.push(role);
  } else if (role && role !== 'all') {
    throw httpError(400, 'Invalid user role filter.');
  }
  if (from !== null) {
    conditions.push('u.created_at >= ?');
    values.push(from);
  }
  if (to !== null) {
    conditions.push('u.created_at <= ?');
    values.push(to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = database.prepare(`SELECT COUNT(*) AS total FROM users u ${where}`).get(...values).total;
  const users = database.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, u.profile_image_url AS profileImage,
      u.created_at AS createdAt, u.email_verified_at AS emailVerifiedAt,
      u.account_status AS accountStatus, u.role,
      u.last_login_at AS lastLoginAt, u.last_logout_at AS lastLogoutAt,
      u.last_active_at AS lastActiveAt, u.successful_login_count AS successfulLoginCount,
      (SELECT COUNT(*) FROM sessions s
        WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS activeSessions
    FROM users u ${where}
    ORDER BY u.created_at DESC LIMIT ? OFFSET ?
  `).all(Date.now(), ...values, pageSize, offset);
  return { users, total, page, pageSize };
}

function getUserDetails(database, userId) {
  const user = database.prepare(`
    SELECT id, email, display_name AS displayName, profile_image_url AS profileImage,
      created_at AS createdAt, email_verified_at AS emailVerifiedAt,
      account_status AS accountStatus, role, last_login_at AS lastLoginAt,
      last_logout_at AS lastLogoutAt, last_active_at AS lastActiveAt,
      successful_login_count AS successfulLoginCount
    FROM users WHERE id = ?
  `).get(userId);
  if (!user) throw httpError(404, 'User not found.');
  user.activeSessions = database.prepare(`
    SELECT session_id AS id, created_at AS createdAt, last_seen_at AS lastSeenAt,
      expires_at AS expiresAt, ip_address AS ipAddress, user_agent AS userAgent
    FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT 20
  `).all(userId, Date.now());
  user.recentAuthEvents = database.prepare(`
    SELECT event_type AS eventType, created_at AS createdAt, ip_address AS ipAddress
    FROM auth_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(userId);
  user.recentActivity = database.prepare(`
    SELECT action, summary, created_at AS createdAt
    FROM user_activity WHERE actor_user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(userId);
  return user;
}

function listSessions(database, url) {
  const { page, pageSize, offset } = pagination(url);
  const now = Date.now();
  const rows = database.prepare(`
    SELECT s.session_id AS id, s.user_id AS userId, u.display_name AS displayName,
      u.email, s.created_at AS createdAt, s.last_seen_at AS lastSeenAt,
      s.expires_at AS expiresAt, s.ip_address AS ipAddress, s.user_agent AS userAgent
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.revoked_at IS NULL AND s.expires_at > ?
    ORDER BY s.last_seen_at DESC LIMIT ? OFFSET ?
  `).all(now, pageSize, offset);
  const total = database.prepare(`
    SELECT COUNT(*) AS total FROM sessions WHERE revoked_at IS NULL AND expires_at > ?
  `).get(now).total;
  return { sessions: rows, total, page, pageSize };
}

function listAuthEvents(database, url) {
  const { page, pageSize, offset } = pagination(url);
  const eventType = url.searchParams.get('type')?.trim();
  const conditions = [];
  const values = [];
  if (eventType) {
    if (!/^[a-z_]{1,40}$/.test(eventType)) throw httpError(400, 'Invalid event type filter.');
    conditions.push('event_type = ?');
    values.push(eventType);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const events = database.prepare(`
    SELECT e.id, e.user_id AS userId, COALESCE(u.display_name, e.email) AS account,
      e.email, e.event_type AS eventType, e.ip_address AS ipAddress,
      e.user_agent AS userAgent, e.details_json AS details, e.created_at AS createdAt
    FROM auth_events e LEFT JOIN users u ON u.id = e.user_id
    ${where} ORDER BY e.created_at DESC LIMIT ? OFFSET ?
  `).all(...values, pageSize, offset);
  const total = database.prepare(`SELECT COUNT(*) AS total FROM auth_events ${where}`).get(...values).total;
  return { events, total, page, pageSize };
}

function listActivity(database, url) {
  const { page, pageSize, offset } = pagination(url);
  const action = url.searchParams.get('action')?.trim();
  const conditions = [];
  const values = [];
  if (action) {
    if (!ACTIVITY_ACTIONS.has(action)) throw httpError(400, 'Invalid activity filter.');
    conditions.push('a.action = ?');
    values.push(action);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const activity = database.prepare(`
    SELECT a.id, a.actor_user_id AS userId, u.display_name AS displayName,
      u.email, a.action, a.summary, a.ip_address AS ipAddress,
      a.user_agent AS userAgent, a.created_at AS createdAt
    FROM user_activity a LEFT JOIN users u ON u.id = a.actor_user_id
    ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(...values, pageSize, offset);
  const total = database.prepare(`SELECT COUNT(*) AS total FROM user_activity a ${where}`).get(...values).total;
  return { activity, total, page, pageSize };
}

function listAuditLogs(database, url) {
  const { page, pageSize, offset } = pagination(url);
  const logs = database.prepare(`
    SELECT a.id, a.admin_user_id AS adminUserId, admin.email AS adminEmail,
      a.target_user_id AS targetUserId, target.email AS targetEmail,
      a.action, a.previous_json AS previousValues, a.updated_json AS updatedValues,
      a.result, a.created_at AS createdAt
    FROM admin_audit_logs a
    LEFT JOIN users admin ON admin.id = a.admin_user_id
    LEFT JOIN users target ON target.id = a.target_user_id
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(pageSize, offset);
  const total = database.prepare('SELECT COUNT(*) AS total FROM admin_audit_logs').get().total;
  return { logs, total, page, pageSize };
}

function listAdmins(database) {
  return database.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, u.role,
      u.account_status AS accountStatus, u.email_verified_at AS emailVerifiedAt,
      COALESCE(json_group_array(p.permission) FILTER (WHERE p.permission IS NOT NULL), '[]') AS permissions
    FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
    WHERE u.role IN ('admin', 'super_admin')
    GROUP BY u.id ORDER BY u.role DESC, u.display_name COLLATE NOCASE
  `).all().map((admin) => ({ ...admin, permissions: JSON.parse(admin.permissions) }));
}

function listAdminContacts(database, url) {
  const { page, pageSize, offset } = pagination(url);
  const contacts = database.prepare(`
    SELECT c.id, c.status, c.created_at AS createdAt,
      requester.id AS requesterId, requester.display_name AS requesterName,
      requester.email AS requesterEmail, addressee.id AS addresseeId,
      addressee.display_name AS addresseeName, addressee.email AS addresseeEmail
    FROM contacts c
    JOIN users requester ON requester.id = c.requester_id
    JOIN users addressee ON addressee.id = c.addressee_id
    ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `).all(pageSize, offset);
  const total = database.prepare('SELECT COUNT(*) AS total FROM contacts').get().total;
  return { contacts, total, page, pageSize };
}

function listCallDevices(database, getConnectionInfo = () => ({ online: false, mobileConnected: false, connectedSessions: 0 })) {
  const devices = database.prepare(`
    SELECT d.id, d.user_id AS userId, d.phone_number AS phoneNumber,
      d.device_name AS deviceName, d.device_type AS deviceType,
      d.phone_verified_at AS phoneVerifiedAt, d.calls_enabled AS callsEnabled,
      d.created_at AS createdAt, d.updated_at AS updatedAt,
      u.display_name AS displayName, u.email, u.account_status AS accountStatus
    FROM approved_call_devices d
    JOIN users u ON u.id = d.user_id
    ORDER BY d.created_at DESC
  `).all().map((device) => ({
    ...device,
    callsEnabled: Boolean(device.callsEnabled),
    ...getConnectionInfo(device.userId)
  }));
  const users = database.prepare(`
    SELECT id, display_name AS displayName, email
    FROM users
    WHERE account_status = 'active' AND email_verified_at IS NOT NULL
    ORDER BY display_name COLLATE NOCASE
  `).all();
  return { devices, users };
}

async function createCallDevice(request, response, database, admin, controls) {
  const body = await readJson(request);
  const device = validateCallDevice(database, body, null, admin.id);
  const id = randomUUID();
  const now = Date.now();
  try {
    runTransaction(database, () => {
      database.prepare(`
        INSERT INTO approved_call_devices(
          id, user_id, phone_number, device_name, device_type,
          phone_verified_at, verified_by, calls_enabled, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        device.userId,
        device.phoneNumber,
        device.deviceName,
        device.deviceType,
        device.phoneVerifiedAt,
        device.verifiedBy,
        device.callsEnabled ? 1 : 0,
        admin.id,
        now,
        now
      );
      writeAudit(database, admin.id, device.userId, 'call_device_registered', {}, {
        deviceId: id,
        deviceName: device.deviceName,
        deviceType: device.deviceType,
        phoneLastFour: device.phoneNumber.slice(-4),
        phoneVerified: Boolean(device.phoneVerifiedAt),
        callsEnabled: device.callsEnabled
      }, now);
    });
  } catch (error) {
    if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
      throw httpError(409, 'That phone number is already registered.');
    }
    throw error;
  }
  if (!hasEnabledCallDevice(database, device.userId)) controls.terminateUserCalls?.(device.userId);
  json(response, 201, { device: { id, ...device } });
}

async function updateCallDevice(request, response, database, admin, deviceId, controls) {
  const current = database.prepare(
    'SELECT * FROM approved_call_devices WHERE id = ?'
  ).get(deviceId);
  if (!current) throw httpError(404, 'Approved call device not found.');
  const body = await readJson(request);
  const device = validateCallDevice(database, body, current, admin.id);
  const now = Date.now();
  try {
    runTransaction(database, () => {
      database.prepare(`
        UPDATE approved_call_devices SET user_id = ?, phone_number = ?, device_name = ?,
          device_type = ?, phone_verified_at = ?, verified_by = ?, calls_enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        device.userId,
        device.phoneNumber,
        device.deviceName,
        device.deviceType,
        device.phoneVerifiedAt,
        device.verifiedBy,
        device.callsEnabled ? 1 : 0,
        now,
        deviceId
      );
      writeAudit(database, admin.id, device.userId, 'call_device_updated', {
        deviceName: current.device_name,
        deviceType: current.device_type,
        phoneLastFour: current.phone_number.slice(-4),
        phoneVerified: Boolean(current.phone_verified_at),
        callsEnabled: Boolean(current.calls_enabled)
      }, {
        deviceId,
        deviceName: device.deviceName,
        deviceType: device.deviceType,
        phoneLastFour: device.phoneNumber.slice(-4),
        phoneVerified: Boolean(device.phoneVerifiedAt),
        callsEnabled: device.callsEnabled
      }, now);
    });
  } catch (error) {
    if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
      throw httpError(409, 'That phone number is already registered.');
    }
    throw error;
  }
  if (!hasEnabledCallDevice(database, current.user_id)) controls.terminateUserCalls?.(current.user_id);
  json(response, 200, { device: { id: deviceId, ...device } });
}

function removeCallDevice(response, database, admin, deviceId, controls) {
  const current = database.prepare(
    'SELECT user_id, device_name, device_type, phone_number, phone_verified_at, calls_enabled FROM approved_call_devices WHERE id = ?'
  ).get(deviceId);
  if (!current) throw httpError(404, 'Approved call device not found.');
  const now = Date.now();
  runTransaction(database, () => {
    database.prepare('DELETE FROM approved_call_devices WHERE id = ?').run(deviceId);
    writeAudit(database, admin.id, current.user_id, 'call_device_removed', {
      deviceName: current.device_name,
      deviceType: current.device_type,
      phoneLastFour: current.phone_number.slice(-4),
      phoneVerified: Boolean(current.phone_verified_at),
      callsEnabled: Boolean(current.calls_enabled)
    }, {}, now);
  });
  if (!hasEnabledCallDevice(database, current.user_id)) controls.terminateUserCalls?.(current.user_id);
  json(response, 200, { ok: true });
}

function validateCallDevice(database, body, current, adminId) {
  const rawUserId = body.userId === undefined ? current?.user_id : body.userId;
  const userId = typeof rawUserId === 'string' ? rawUserId.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw httpError(400, 'Select an existing verified user account.');
  const account = database.prepare(`
    SELECT id FROM users
    WHERE id = ? AND account_status = 'active' AND email_verified_at IS NOT NULL
  `).get(userId);
  if (!account) throw httpError(404, 'An active, email-verified account is required.');

  const phoneInput = body.phoneNumber === undefined ? current?.phone_number : body.phoneNumber;
  const phoneNumber = normalizePhoneNumber(phoneInput);
  const rawDeviceName = body.deviceName === undefined ? current?.device_name : body.deviceName;
  const deviceName = typeof rawDeviceName === 'string' ? rawDeviceName.trim() : '';
  if (deviceName.length < 2 || deviceName.length > 80) {
    throw httpError(400, 'Device name must be between 2 and 80 characters.');
  }
  const deviceType = body.deviceType === undefined ? current?.device_type : body.deviceType;
  if (!['mobile', 'desktop'].includes(deviceType)) throw httpError(400, 'Device type must be mobile or desktop.');

  const phoneChanged = !current || phoneNumber !== current.phone_number;
  let phoneVerifiedAt = current?.phone_verified_at || null;
  let verifiedBy = current?.verified_by || null;
  if (body.phoneVerified === true) {
    phoneVerifiedAt = Date.now();
    verifiedBy = adminId;
  } else if (body.phoneVerified === false || phoneChanged) {
    phoneVerifiedAt = null;
    verifiedBy = null;
  }
  const callsEnabled = body.callsEnabled === undefined
    ? Boolean(current?.calls_enabled)
    : body.callsEnabled;
  if (typeof callsEnabled !== 'boolean') throw httpError(400, 'Calling permission must be enabled or disabled.');
  if (callsEnabled && !phoneVerifiedAt) {
    throw httpError(400, 'Verify the phone number before enabling calls.');
  }
  return { userId, phoneNumber, deviceName, deviceType, phoneVerifiedAt, verifiedBy, callsEnabled };
}

function normalizePhoneNumber(value) {
  if (typeof value !== 'string') throw httpError(400, 'Enter a phone number in international format.');
  const phoneNumber = value.trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw httpError(400, 'Phone number must use international E.164 format, for example +14155550123.');
  }
  return phoneNumber;
}

function hasEnabledCallDevice(database, userId) {
  return Boolean(database.prepare(`
    SELECT 1 FROM approved_call_devices
    WHERE user_id = ? AND phone_verified_at IS NOT NULL AND calls_enabled = 1
  `).get(userId));
}

function listAdminCalls(database, url) {
  const { page, pageSize, offset } = pagination(url);
  const calls = database.prepare(`
    SELECT c.id, c.mode, c.status, c.created_at AS createdAt,
      c.answered_at AS answeredAt, c.ended_at AS endedAt,
      caller.id AS callerId, caller.display_name AS callerName, caller.email AS callerEmail,
      callee.id AS calleeId, callee.display_name AS calleeName, callee.email AS calleeEmail
    FROM calls c
    JOIN users caller ON caller.id = c.caller_id
    JOIN users callee ON callee.id = c.callee_id
    ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `).all(pageSize, offset);
  const total = database.prepare('SELECT COUNT(*) AS total FROM calls').get().total;
  return { calls, total, page, pageSize };
}

function getSecuritySnapshot(database) {
  const now = Date.now();
  return {
    failedLoginsLast24Hours: database.prepare(`
      SELECT COUNT(*) AS count FROM auth_events
      WHERE event_type = 'login_failed' AND created_at >= ?
    `).get(now - 24 * 60 * 60 * 1000).count,
    activeSessions: database.prepare(`
      SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL AND expires_at > ?
    `).get(now).count,
    revokedSessions: database.prepare(`
      SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NOT NULL
    `).get().count,
    suspendedAccounts: database.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE account_status = 'suspended'
    `).get().count,
    deletedAccounts: database.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE account_status = 'deleted'
    `).get().count,
    eventRetentionDays: EVENT_RETENTION_MS / (24 * 60 * 60 * 1000)
  };
}

async function changeUserRole(request, response, database, superAdmin, targetId) {
  const body = await readJson(request);
  if (!['user', 'admin'].includes(body.role)) {
    throw httpError(400, 'Only the user and admin roles can be assigned here.');
  }
  const target = database.prepare(`
    SELECT id, email, role, account_status, email_verified_at FROM users WHERE id = ?
  `).get(targetId);
  if (!target) throw httpError(404, 'User not found.');
  if (target.id === superAdmin.id || target.role === 'super_admin') {
    throw httpError(403, 'Super Admin accounts cannot be changed here.');
  }
  if (body.role === 'admin' && (target.account_status !== 'active' || !target.email_verified_at)) {
    throw httpError(400, 'Only active, verified accounts can be promoted to Admin.');
  }

  const now = Date.now();
  runTransaction(database, () => {
    database.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, targetId);
    if (body.role === 'admin' && target.role !== 'admin') {
      database.prepare(`
        INSERT OR IGNORE INTO user_permissions(user_id, permission, granted_by, granted_at)
        VALUES (?, 'admin.access', ?, ?), (?, 'users.read', ?, ?)
      `).run(targetId, superAdmin.id, now, targetId, superAdmin.id, now);
    } else if (body.role === 'user') {
      database.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(targetId);
    }
    writeAudit(database, superAdmin.id, targetId, 'user_role_changed', { role: target.role }, { role: body.role }, now);
  });
  json(response, 200, { role: body.role, userId: targetId });
}

async function updateUser(request, response, database, admin, targetId, controls) {
  const body = await readJson(request);
  getManageableUser(database, targetId, admin);
  const current = database.prepare(`
    SELECT id, email, display_name, profile_image_url, role, account_status
    FROM users WHERE id = ?
  `).get(targetId);

  const nextName = body.displayName === undefined ? current.display_name : cleanText(body.displayName, 2, 80);
  let nextProfileImage = current.profile_image_url;
  if (body.profileImageUrl !== undefined) {
    try {
      nextProfileImage = cleanProfileImageUrl(body.profileImageUrl);
    } catch (error) {
      throw httpError(400, error.message);
    }
  }
  const nextStatus = body.accountStatus === undefined ? current.account_status : body.accountStatus;
  if (!nextName) throw httpError(400, 'Display name must be between 2 and 80 characters.');
  if (!['active', 'suspended'].includes(nextStatus)) throw httpError(400, 'Invalid account status.');

  const now = Date.now();
  const previous = {
    displayName: current.display_name,
    profileImageUrl: current.profile_image_url,
    accountStatus: current.account_status
  };
  const updated = { displayName: nextName, profileImageUrl: nextProfileImage, accountStatus: nextStatus };
  runTransaction(database, () => {
    database.prepare(`
      UPDATE users
      SET display_name = ?, profile_image_url = ?, account_status = ?
      WHERE id = ?
    `).run(nextName, nextProfileImage, nextStatus, current.id);
    if (nextStatus !== 'active') revokeUserSessions(database, current.id, now);
    writeAudit(database, admin.id, current.id, 'user_updated', previous, updated, now);
  });
  if (nextStatus !== 'active') controls.closeUserSockets?.(current.id);
  json(response, 200, { user: getUserDetails(database, current.id) });
}

async function sendUserPasswordReset(response, database, admin, targetId, url) {
  const target = getManageableUser(database, targetId, admin);
  const account = database.prepare(`
    SELECT email, display_name, email_verified_at
    FROM users WHERE id = ? AND account_status = 'active'
  `).get(targetId);
  if (!account || !account.email_verified_at) {
    throw httpError(409, 'Password reset is available only for active, verified accounts.');
  }

  let mailResult;
  try {
    mailResult = await issuePasswordReset(database, {
      userId: targetId,
      email: account.email,
      displayName: account.display_name,
      origin: process.env.PUBLIC_ORIGIN || url.origin
    });
  } catch {
    runTransaction(database, () => {
      writeAudit(database, admin.id, targetId, 'password_reset_requested', {}, {}, Date.now(), 'failure');
    });
    throw httpError(503, 'Password reset email could not be sent. Please try again later.');
  }

  runTransaction(database, () => {
    writeAudit(database, admin.id, targetId, 'password_reset_requested', {}, { emailSent: true }, Date.now());
  });
  json(response, 200, {
    message: `Password reset instructions sent to ${account.email}.`,
    ...(mailResult.developmentUrl ? { developmentResetUrl: mailResult.developmentUrl } : {})
  });
}

function softDeleteUser(response, database, admin, targetId, controls) {
  const target = getManageableUser(database, targetId, admin);
  if (target.account_status === 'deleted') throw httpError(409, 'Account is already deleted.');
  const now = Date.now();
  runTransaction(database, () => {
    database.prepare("UPDATE users SET account_status = 'deleted' WHERE id = ?").run(targetId);
    revokeUserSessions(database, targetId, now);
    writeAudit(database, admin.id, targetId, 'user_soft_deleted', { accountStatus: target.account_status }, { accountStatus: 'deleted' }, now);
  });
  controls.closeUserSockets?.(targetId);
  json(response, 200, { ok: true });
}

function restoreUser(response, database, admin, targetId) {
  const target = getManageableUser(database, targetId, admin);
  if (target.account_status !== 'deleted') throw httpError(409, 'Only deleted accounts can be restored.');
  const now = Date.now();
  runTransaction(database, () => {
    database.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(targetId);
    writeAudit(database, admin.id, targetId, 'user_restored', { accountStatus: 'deleted' }, { accountStatus: 'active' }, now);
  });
  json(response, 200, { user: getUserDetails(database, targetId) });
}

async function permanentlyDeleteUser(request, response, database, admin, targetId) {
  const target = getManageableUser(database, targetId, admin);
  const body = await readJson(request);
  if (target.account_status !== 'deleted' || body.confirmEmail !== target.email) {
    throw httpError(400, 'Mark the account deleted first and confirm its email address.');
  }
  const now = Date.now();
  runTransaction(database, () => {
    writeAudit(database, admin.id, targetId, 'user_permanently_deleted', { email: target.email, accountStatus: target.account_status }, {}, now);
    database.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  });
  json(response, 200, { ok: true });
}

function getManageableUser(database, targetId, admin) {
  const target = database.prepare(`
    SELECT id, email, role, account_status FROM users WHERE id = ?
  `).get(targetId);
  if (!target) throw httpError(404, 'User not found.');
  if (
    target.id === admin.id
    || target.role === 'super_admin'
    || (target.role === 'admin' && admin.role !== 'super_admin')
  ) {
    throw httpError(403, 'This account cannot be changed through user management.');
  }
  return target;
}

function revokeSession(response, database, admin, sessionId, controls) {
  const session = database.prepare(`
    SELECT session_id, user_id, revoked_at, expires_at FROM sessions WHERE session_id = ?
  `).get(sessionId);
  if (!session || session.revoked_at !== null || session.expires_at <= Date.now()) {
    throw httpError(404, 'Active session not found.');
  }
  const now = Date.now();
  runTransaction(database, () => {
    database.prepare('UPDATE sessions SET revoked_at = ? WHERE session_id = ?').run(now, sessionId);
    writeAudit(database, admin.id, session.user_id, 'session_revoked', {}, { sessionId, revokedAt: now }, now);
  });
  controls.closeUserSockets?.(session.user_id, sessionId);
  json(response, 200, { ok: true });
}

async function replaceAdminPermissions(request, response, database, superAdmin, targetId) {
  const body = await readJson(request);
  if (!Array.isArray(body.permissions) || body.permissions.length > PERMISSIONS.length) {
    throw httpError(400, 'Provide a valid permissions list.');
  }
  const permissions = [...new Set(body.permissions)];
  if (permissions.some((permission) => !PERMISSION_KEYS.has(permission))) {
    throw httpError(400, 'The permissions list contains an unsupported permission.');
  }
  const target = database.prepare(`
    SELECT id, email, role FROM users WHERE id = ?
  `).get(targetId);
  if (!target || target.role !== 'admin') throw httpError(404, 'Admin account not found.');
  if (target.id === superAdmin.id) throw httpError(403, 'You cannot change your own permissions.');

  const previous = database.prepare(
    'SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission'
  ).all(targetId).map(({ permission }) => permission);
  const now = Date.now();
  runTransaction(database, () => {
    database.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(targetId);
    const insert = database.prepare(`
      INSERT INTO user_permissions(user_id, permission, granted_by, granted_at) VALUES (?, ?, ?, ?)
    `);
    for (const permission of permissions) insert.run(targetId, permission, superAdmin.id, now);
    writeAudit(database, superAdmin.id, targetId, 'admin_permissions_updated', { permissions: previous }, { permissions }, now);
  });
  json(response, 200, { permissions });
}

function requirePermission(database, user, permission, path) {
  if (user.role === 'super_admin') return;
  const granted = user.role === 'admin' && database.prepare(`
    SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?
  `).get(user.id, permission);
  if (!granted) {
    writeAudit(database, user.id, null, 'admin_permission_denied', { path }, { permission }, Date.now(), 'failure');
    throw httpError(403, 'You do not have permission to perform this action.');
  }
}

function requireSuperAdmin(database, user, path) {
  if (user.role === 'super_admin') return;
  writeAudit(database, user.id, null, 'super_admin_permission_denied', { path }, {}, Date.now(), 'failure');
  throw httpError(403, 'Super Admin access is required.');
}

function getAdminProfile(database, user) {
  const account = database.prepare(`
    SELECT id, email, username, display_name AS displayName,
      profile_image_url AS profileImage, email_verified_at AS emailVerifiedAt, role
    FROM users WHERE id = ?
  `).get(user.id);
  return {
    ...account,
    permissions: user.role === 'super_admin'
      ? PERMISSIONS.map(({ key }) => key)
      : database.prepare('SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission')
        .all(user.id).map(({ permission }) => permission)
  };
}

async function updateAdminProfile(request, response, database, admin, url, controls) {
  const body = await readJson(request);
  const current = database.prepare(`
    SELECT id, email, username, display_name, profile_image_url, email_verified_at, password_hash
    FROM users WHERE id = ?
  `).get(admin.id);
  const nextEmail = body.email === undefined ? current.email : String(body.email).trim().toLowerCase();
  const nextUsername = body.username === undefined ? current.username : String(body.username).trim().toLowerCase();
  const nextName = body.displayName === undefined ? current.display_name : cleanText(body.displayName, 2, 80);
  let nextProfileImage = current.profile_image_url;
  if (body.profileImageUrl !== undefined) {
    try {
      nextProfileImage = cleanProfileImageUrl(body.profileImageUrl);
    } catch (error) {
      throw httpError(400, error.message);
    }
  }
  const newPassword = body.newPassword === undefined ? '' : String(body.newPassword);
  const emailChanged = nextEmail !== current.email.toLowerCase();
  const usernameChanged = nextUsername !== current.username;
  const passwordChanged = Boolean(newPassword);
  const credentialsChanged = emailChanged || usernameChanged || passwordChanged;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail) || nextEmail.length > 254) {
    throw httpError(400, 'Enter a valid email address.');
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(nextUsername)) {
    throw httpError(400, 'Username must be 3–32 characters using letters, numbers, dots, underscores or hyphens.');
  }
  if (!nextName) throw httpError(400, 'Display name must be between 2 and 80 characters.');
  if (passwordChanged && (newPassword.length < 6 || newPassword.length > 128)) {
    throw httpError(400, 'New password must be between 6 and 128 characters.');
  }
  if (credentialsChanged) {
    if (
      typeof body.currentPassword !== 'string'
      || body.currentPassword.length > 128
      || !await verifyPassword(body.currentPassword, current.password_hash)
    ) {
      throw httpError(401, 'Current password is incorrect.');
    }
  }

  const duplicateEmail = database.prepare('SELECT id FROM users WHERE email = ? AND id <> ?')
    .get(nextEmail, admin.id);
  if (duplicateEmail) throw httpError(409, 'That email address is already in use.');
  const duplicateUsername = database.prepare('SELECT id FROM users WHERE username = ? AND id <> ?')
    .get(nextUsername, admin.id);
  if (duplicateUsername) throw httpError(409, 'That username is already in use.');

  let verificationToken = '';
  let mailResult = null;
  if (emailChanged) {
    verificationToken = createToken();
    const verificationUrl = new URL('/', process.env.PUBLIC_ORIGIN || url.origin);
    verificationUrl.searchParams.set('verify', verificationToken);
    try {
      mailResult = await sendVerificationEmail({
        email: nextEmail,
        displayName: nextName,
        verificationUrl: verificationUrl.toString()
      });
    } catch (error) {
      console.error('Unable to deliver administrator email-change verification:', error);
      throw httpError(503, 'A verification email could not be sent. Your profile was not changed.');
    }
  }

  const sessionToken = readSessionToken(request);
  const currentSession = database.prepare(`
    SELECT session_id FROM sessions
    WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(hashToken(sessionToken), admin.id, Date.now());
  if (!currentSession) throw httpError(401, 'Your session has expired. Sign in again.');

  const passwordHash = passwordChanged ? await hashPassword(newPassword) : current.password_hash;
  const now = Date.now();
  const previous = {
    email: current.email,
    username: current.username,
    displayName: current.display_name,
    profileImageUrl: current.profile_image_url,
    emailVerified: Boolean(current.email_verified_at)
  };
  const updated = {
    email: nextEmail,
    username: nextUsername,
    displayName: nextName,
    profileImageUrl: nextProfileImage,
    emailVerified: emailChanged ? false : Boolean(current.email_verified_at),
    passwordChanged
  };

  try {
    runTransaction(database, () => {
      database.prepare(`
        UPDATE users
        SET email = ?, username = ?, display_name = ?, profile_image_url = ?,
          password_hash = ?, email_verified_at = ?
        WHERE id = ?
      `).run(
        nextEmail,
        nextUsername,
        nextName,
        nextProfileImage,
        passwordHash,
        emailChanged ? null : current.email_verified_at,
        admin.id
      );
      if (emailChanged) {
        database.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(admin.id);
        database.prepare(`
          INSERT INTO email_verifications(token_hash, user_id, expires_at) VALUES (?, ?, ?)
        `).run(hashToken(verificationToken), admin.id, now + 30 * 60 * 1000);
      }
      if (credentialsChanged) {
        database.prepare(`
          UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND session_id <> ? AND revoked_at IS NULL
        `).run(now, admin.id, currentSession.session_id);
      }
      writeAudit(database, admin.id, admin.id, 'admin_profile_updated', previous, updated, now);
    });
  } catch (error) {
    if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
      throw httpError(409, 'That email address or username is already in use.');
    }
    throw error;
  }

  if (credentialsChanged) controls.closeUserSockets?.(admin.id, currentSession.session_id);
  json(response, 200, {
    profile: getAdminProfile(database, { ...admin, email: nextEmail, username: nextUsername, displayName: nextName }),
    message: emailChanged
      ? 'Profile updated. Verify your new email address to enable verified-account features.'
      : 'Admin profile updated.',
    ...(mailResult?.developmentUrl ? { developmentVerificationUrl: mailResult.developmentUrl } : {})
  });
}

function readSessionToken(request) {
  for (const segment of String(request.headers.cookie || '').split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0 || segment.slice(0, separator).trim() !== 'ss_session') continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function writeAudit(database, adminId, targetId, action, previous, updated, now, result = 'success') {
  database.prepare(`
    INSERT INTO admin_audit_logs(
      id, admin_user_id, target_user_id, action, previous_json, updated_json, result, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    adminId,
    targetId,
    action,
    JSON.stringify(previous),
    JSON.stringify(updated),
    result,
    now
  );
}

function revokeUserSessions(database, userId, now) {
  database.prepare(`
    UPDATE sessions SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).run(now, userId);
}

function pagination(url) {
  const rawPage = url.searchParams.get('page') || '1';
  const rawPageSize = url.searchParams.get('pageSize') || '25';
  if (!/^\d+$/.test(rawPage) || !/^\d+$/.test(rawPageSize)) {
    throw httpError(400, 'Page and page size must be positive integers.');
  }
  const page = Number(rawPage);
  const pageSize = Number(rawPageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw httpError(400, `Page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseDateFilter(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw httpError(400, 'Invalid registration date filter.');
  return timestamp;
}

function requestMetadata(request) {
  return {
    ipAddress: cleanOptionalText(request?.socket?.remoteAddress, 128),
    userAgent: cleanOptionalText(request?.headers?.['user-agent'], 512)
  };
}

function cleanOptionalText(value, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 16 * 1024) throw httpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON object.');
    return body;
  } catch {
    throw httpError(400, 'Request body must be valid JSON.');
  }
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

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
