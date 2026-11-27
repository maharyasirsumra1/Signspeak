import { createToken, hashToken } from './security.js';
import { sendPasswordResetEmail } from './mailer.js';

const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export async function issuePasswordReset(database, { userId, email, displayName, origin }) {
  const token = createToken();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const resetUrl = new URL('/', origin);
  resetUrl.searchParams.set('reset', token);

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
    database.prepare(`
      INSERT INTO password_reset_tokens(token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(tokenHash, userId, now + PASSWORD_RESET_TTL_MS, now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  try {
    return await sendPasswordResetEmail({
      email,
      displayName,
      resetUrl: resetUrl.toString()
    });
  } catch (error) {
    database.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(tokenHash);
    throw error;
  }
}
