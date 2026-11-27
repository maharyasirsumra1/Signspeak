import { existsSync, mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const databasePath = resolve(
  process.env.SIGNSPEAK_DB_PATH || 'server/data/signspeak.sqlite'
);

mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);

const hasExistingDatabase = existsSync(databasePath) && statSync(databasePath).size > 0;

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    username TEXT COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_verifications (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS google_identities (
    google_subject TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS external_identities (
    provider TEXT NOT NULL CHECK (provider IN ('google', 'facebook')),
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(provider, subject),
    UNIQUE(provider, user_id)
  );
  INSERT OR IGNORE INTO external_identities(provider, subject, user_id, created_at)
    SELECT 'google', google_subject, user_id, created_at FROM google_identities;

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at INTEGER NOT NULL,
    UNIQUE(requester_id, addressee_id),
    CHECK (requester_id <> addressee_id)
  );
  CREATE INDEX IF NOT EXISTS contacts_addressee_idx ON contacts(addressee_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS contacts_pair_idx
    ON contacts(min(requester_id, addressee_id), max(requester_id, addressee_id));

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('deaf-to-deaf', 'deaf-to-hearing')),
    status TEXT NOT NULL CHECK (
      status IN ('ringing', 'connecting', 'connected', 'declined', 'missed', 'ended', 'interrupted')
    ),
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS calls_caller_idx ON calls(caller_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS calls_callee_idx ON calls(callee_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS call_history_hidden (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, call_id)
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const userColumns = [
  ['username', 'TEXT COLLATE NOCASE'],
  ['role', "TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'super_admin'))"],
  ['account_status', "TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'deleted'))"],
  ['profile_image_url', 'TEXT'],
  ['last_login_at', 'INTEGER'],
  ['last_logout_at', 'INTEGER'],
  ['last_active_at', 'INTEGER'],
  ['successful_login_count', 'INTEGER NOT NULL DEFAULT 0']
];
const sessionColumns = [
  ['session_id', 'TEXT'],
  ['ip_address', 'TEXT'],
  ['user_agent', 'TEXT'],
  ['last_seen_at', 'INTEGER'],
  ['revoked_at', 'INTEGER']
];
const missingUserColumns = userColumns.filter(([name]) => !hasColumn('users', name));
const missingSessionColumns = sessionColumns.filter(([name]) => !hasColumn('sessions', name));
const newTables = [
  'auth_events',
  'user_activity',
  'admin_audit_logs',
  'user_permissions',
  'password_reset_tokens',
  'approved_call_devices'
].filter((name) => !hasTable(name));

if (hasExistingDatabase && (missingUserColumns.length || missingSessionColumns.length || newTables.length)) {
  backupDatabase();
}

for (const [name, definition] of missingUserColumns) {
  db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}
for (const [name, definition] of missingSessionColumns) {
  db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
}

const existingUsernames = new Set(
  db.prepare('SELECT username FROM users WHERE username IS NOT NULL').all()
    .map(({ username }) => username.toLowerCase())
);
const usersMissingUsername = db.prepare(
  'SELECT id, email FROM users WHERE username IS NULL OR username = \'\' ORDER BY id'
).all();
const setUsername = db.prepare('UPDATE users SET username = ? WHERE id = ?');
for (const user of usersMissingUsername) {
  const username = makeLegacyUsername(user.email, user.id, existingUsernames);
  setUsername.run(username, user.id);
  existingUsernames.add(username.toLowerCase());
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users(username COLLATE NOCASE)');

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    email TEXT,
    event_type TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_events_created_idx ON auth_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS auth_events_user_idx ON auth_events(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS auth_events_type_idx ON auth_events(event_type, created_at DESC);

  CREATE TABLE IF NOT EXISTS user_activity (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    subject_user_id TEXT,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_activity_created_idx ON user_activity(created_at DESC);
  CREATE INDEX IF NOT EXISTS user_activity_actor_idx ON user_activity(actor_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS user_activity_action_idx ON user_activity(action, created_at DESC);

  CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id TEXT PRIMARY KEY,
    admin_user_id TEXT,
    target_user_id TEXT,
    action TEXT NOT NULL,
    previous_json TEXT NOT NULL DEFAULT '{}',
    updated_json TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON admin_audit_logs(target_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, permission)
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_tokens(user_id);

  CREATE TABLE IF NOT EXISTS approved_call_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    device_type TEXT NOT NULL CHECK (device_type IN ('mobile', 'desktop')),
    phone_verified_at INTEGER,
    verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    calls_enabled INTEGER NOT NULL DEFAULT 0 CHECK (calls_enabled IN (0, 1)),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS approved_call_devices_user_idx
    ON approved_call_devices(user_id, calls_enabled, phone_verified_at);

  CREATE TRIGGER IF NOT EXISTS admin_audit_no_update
    BEFORE UPDATE ON admin_audit_logs
    BEGIN SELECT RAISE(ABORT, 'Admin audit logs are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete
    BEFORE DELETE ON admin_audit_logs
    BEGIN SELECT RAISE(ABORT, 'Admin audit logs are append-only'); END;
`);

const sessionRows = db.prepare('SELECT rowid, created_at FROM sessions WHERE session_id IS NULL').all();
const fillSessionId = db.prepare('UPDATE sessions SET session_id = ?, last_seen_at = COALESCE(last_seen_at, ?) WHERE rowid = ?');
for (const session of sessionRows) {
  fillSessionId.run(randomUUID(), session.created_at, session.rowid);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_id_idx ON sessions(session_id)');
db.exec(`
  UPDATE users SET
    successful_login_count = MAX(successful_login_count, (
      SELECT COUNT(*) FROM sessions WHERE sessions.user_id = users.id
    )),
    last_login_at = COALESCE(last_login_at, (
      SELECT MAX(created_at) FROM sessions WHERE sessions.user_id = users.id
    )),
    last_active_at = COALESCE(last_active_at, (
      SELECT MAX(created_at) FROM sessions WHERE sessions.user_id = users.id
    ));
`);

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function hasTable(table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function makeLegacyUsername(email, userId, existingUsernames) {
  const base = email.split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 32);
  const safeBase = base.length >= 3 ? base : 'user';
  let candidate = safeBase;
  if (existingUsernames.has(candidate.toLowerCase())) {
    const suffix = `-${userId.replace(/-/g, '').slice(0, 6)}`;
    candidate = `${safeBase.slice(0, 32 - suffix.length)}${suffix}`;
  }
  let sequence = 2;
  while (existingUsernames.has(candidate.toLowerCase())) {
    const suffix = `-${userId.replace(/-/g, '').slice(0, 5)}${sequence}`;
    candidate = `${safeBase.slice(0, 32 - suffix.length)}${suffix}`;
    sequence += 1;
  }
  return candidate;
}

function backupDatabase() {
  const backupDirectory = join(dirname(databasePath), 'backups');
  mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDirectory, `signspeak-before-schema-migration-${timestamp}.sqlite`);
  db.prepare('VACUUM INTO ?').run(backupPath);
}

export function closeDatabase() {
  db.close();
}
