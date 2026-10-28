/**
 * Crypto helpers built only on WebCrypto, so the same code runs on Cloudflare Workers and
 * Node 22 (both expose globalThis.crypto).
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const encoder = new TextEncoder();

/** Uniform random integer in [0, max) using rejection sampling. */
export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0]! < limit) return buffer[0]! % max;
  }
}

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

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * PBKDF2-SHA256. 60,000 iterations keeps a login under the Workers free plan's 10 ms CPU
 * budget; the stored format records the count so it can be raised later without breaking logins.
 */
const PBKDF2_ITERATIONS = 60_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsText, saltText, keyText] = stored.split('$');
  const iterations = Number(iterationsText);
  if (scheme !== 'pbkdf2' || !Number.isInteger(iterations) || iterations < 1 || !saltText || !keyText) return false;
  const actual = await pbkdf2(password, fromBase64Url(saltText), iterations);
  return safeEqual(toBase64Url(actual), keyText);
}
