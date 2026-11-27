import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createToken() {
  return randomBytes(32).toString('base64url');
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

export async function verifyPassword(password, encodedHash) {
  const [algorithm, n, r, p, saltValue, keyValue] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !keyValue) return false;

  const expected = Buffer.from(keyValue, 'base64url');
  const actual = Buffer.from(await scryptAsync(
    password,
    Buffer.from(saltValue, 'base64url'),
    expected.length,
    {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024
    }
  ));

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
