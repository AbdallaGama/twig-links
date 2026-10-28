import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { hashPassword, prefixedId, randomToken, safeEqual, sha256Hex, verifyPassword } from './util/crypto.ts';
import type { Ctx } from './util/http.ts';
import { header, HttpError, setCookieHeader, str } from './util/http.ts';

export type Role = 'owner' | 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  created_at: number;
}

export const SESSION_COOKIE = 'twig_session';
const SESSION_TTL_MS = 14 * 86400 * 1000;

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role, createdAt: row.created_at };
}

export async function userCount(db: Db): Promise<number> {
  return (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))?.n ?? 0;
}

function validatePassword(password: string | null): string {
  if (!password || password.length < 10) throw new HttpError(400, 'weak_password', 'Password must be at least 10 characters');
  return password;
}

export async function createUser(db: Db, input: { email: unknown; name: unknown; password: unknown; role: Role }): Promise<User> {
  const email = str(input.email, 254)?.toLowerCase() ?? null;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_email');
  const password = validatePassword(typeof input.password === 'string' ? input.password : null);
  if (await db.get('SELECT id FROM users WHERE email = ?', email)) throw new HttpError(409, 'email_taken');
  const id = prefixedId('usr', 16);
  await db.run('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, email, str(input.name, 120) ?? email.split('@')[0]!, await hashPassword(password), input.role, Date.now());
  return toUser((await db.get<UserRow>('SELECT * FROM users WHERE id = ?', id))!);
}

export async function listUsers(db: Db): Promise<User[]> {
  return (await db.all<UserRow>('SELECT * FROM users ORDER BY created_at')).map(toUser);
}

export async function deleteUser(db: Db, actor: User, id: string): Promise<void> {
  const target = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!target) throw new HttpError(404, 'user_not_found');
  if (target.role === 'owner') throw new HttpError(400, 'cannot_delete_owner');
  if (target.id === actor.id) throw new HttpError(400, 'cannot_delete_self');
  await db.run('DELETE FROM users WHERE id = ?', id);
}

export async function changePassword(db: Db, user: User, current: unknown, next: unknown): Promise<void> {
  const row = (await db.get<UserRow>('SELECT * FROM users WHERE id = ?', user.id))!;
  if (typeof current !== 'string' || !await verifyPassword(current, row.password_hash)) throw new HttpError(400, 'wrong_password');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(validatePassword(typeof next === 'string' ? next : null)), user.id);
  await db.run('DELETE FROM user_sessions WHERE user_id = ?', user.id);
}

/**
 * First start: create the owner from ADMIN_EMAIL / ADMIN_PASSWORD, or print a one-time setup
 * token that the dashboard's "create owner" screen requires.
 */
export async function bootstrapOwner(db: Db, config: Config, log: (message: string) => void): Promise<void> {
  if (await userCount(db) > 0) return;
  if (config.adminEmail && config.adminPassword) {
    await createUser(db, { email: config.adminEmail, name: 'Owner', password: config.adminPassword, role: 'owner' });
    log(`Created owner account ${config.adminEmail}`);
    return;
  }
  let token = (await db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'setup_token'))?.value;
  if (!token) {
    token = randomToken(18);
    await db.run('INSERT INTO meta (key, value) VALUES (?, ?)', 'setup_token', token);
  }
  log(`No users yet. Open ${config.publicUrl}/dashboard and use setup token: ${token}`);
}

export async function completeSetup(db: Db, body: Record<string, unknown>): Promise<User> {
  if (await userCount(db) > 0) throw new HttpError(409, 'already_set_up');
  const token = (await db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'setup_token'))?.value;
  if (!token || typeof body.setup_token !== 'string' || !safeEqual(body.setup_token.trim(), token)) throw new HttpError(403, 'invalid_setup_token');
  const user = await createUser(db, { email: body.email, name: body.name, password: body.password, role: 'owner' });
  await db.run('DELETE FROM meta WHERE key = ?', 'setup_token');
  return user;
}

export async function login(db: Db, email: unknown, password: unknown): Promise<{ user: User; token: string }> {
  const row = typeof email === 'string' ? await db.get<UserRow>('SELECT * FROM users WHERE email = ?', email.trim().toLowerCase()) : undefined;
  // Verify against a dummy hash when the user is unknown so timing does not leak existence.
  const valid = await verifyPassword(typeof password === 'string' ? password : '', row?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  if (!row || !valid) throw new HttpError(401, 'invalid_credentials');
  const token = randomToken(32);
  await db.run('DELETE FROM user_sessions WHERE expires_at < ?', Date.now());
  await db.run('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256Hex(token), row.id, Date.now() + SESSION_TTL_MS);
  return { user: toUser(row), token };
}

export async function logout(db: Db, ctx: Ctx): Promise<void> {
  const token = ctx.cookies[SESSION_COOKIE];
  if (token) await db.run('DELETE FROM user_sessions WHERE token_hash = ?', await sha256Hex(token));
}

export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_TTL_MS / 1000): string {
  return setCookieHeader(SESSION_COOKIE, token, { maxAgeSec, secure, httpOnly: true, sameSite: 'Lax' });
}

export async function currentUser(db: Db, ctx: Ctx): Promise<User | null> {
  const token = ctx.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = await db.get<UserRow>(
    'SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    await sha256Hex(token), Date.now(),
  );
  return row ? toUser(row) : null;
}

/**
 * Dashboard requests authenticate with the session cookie. State-changing requests must also
 * send X-Twig-Client: dashboard — a custom header cross-site forms cannot set (CSRF guard).
 */
export async function requireUser(db: Db, ctx: Ctx, roles: Role[] = ['owner', 'admin', 'member']): Promise<User> {
  const user = await currentUser(db, ctx);
  if (!user) throw new HttpError(401, 'unauthenticated');
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && header(ctx.req, 'x-twig-client') !== 'dashboard') {
    throw new HttpError(403, 'missing_client_header');
  }
  if (!roles.includes(user.role)) throw new HttpError(403, 'forbidden');
  return user;
}

export function bearerToken(ctx: Ctx): string | null {
  const value = header(ctx.req, 'authorization');
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : null;
}
