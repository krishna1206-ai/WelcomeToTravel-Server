import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}

// Checked when an email is unknown, so response time doesn't reveal which emails have accounts.
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export function newToken() {
  return randomBytes(32).toString('base64url');
}

// Only this hash is stored, so a leaked database can't be used to sign in.
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
