import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniformly random base62 string (rejection-free via randomInt). */
export function randomBase62(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62[randomInt(62)];
  return out;
}

export function prefixedId(prefix: string, length = 20): string {
  return `${prefix}_${randomBase62(length)}`;
}

/**
 * Click ids are decimal strings that sort by time: milliseconds since epoch followed by
 * six random digits. Decimal keeps them safe inside Android install-referrer strings
 * and URL query values without escaping.
 */
export function newClickId(now = Date.now()): string {
  return `${now}${String(randomInt(1_000_000)).padStart(6, '0')}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltText, keyText] = stored.split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const actual = scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length, SCRYPT_PARAMS);
  return timingSafeEqual(actual, expected);
}
