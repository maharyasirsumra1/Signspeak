import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'signspeak-migration-test-'));
const databasePath = join(temporaryDirectory, 'legacy.sqlite');
const legacyDatabase = new DatabaseSync(databasePath);
legacyDatabase.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);
legacyDatabase.prepare(`
  INSERT INTO users(id, email, display_name, password_hash, created_at)
  VALUES (?, ?, ?, ?, ?)
`).run('legacy-user', 'legacy@example.test', 'Legacy User', 'test-hash', Date.now());
process.env.SIGNSPEAK_DB_PATH = databasePath;
const { db } = await import('./db.js');

after(() => {
  db.close();
  legacyDatabase.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('backs up a consistent pre-migration SQLite snapshot including WAL data', () => {
  const backupDirectory = join(temporaryDirectory, 'backups');
  const backups = readdirSync(backupDirectory)
    .filter((name) => name.startsWith('signspeak-before-schema-migration-'));
  assert.equal(backups.length, 1);

  const snapshot = new DatabaseSync(join(backupDirectory, backups[0]), { readOnly: true });
  try {
    assert.equal(
      snapshot.prepare('SELECT email FROM users WHERE id = ?').get('legacy-user').email,
      'legacy@example.test'
    );
    assert.equal(
      snapshot.prepare("SELECT name FROM sqlite_master WHERE name = 'approved_call_devices'").get(),
      undefined
    );
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'approved_call_devices'").get());
  } finally {
    snapshot.close();
  }
});
