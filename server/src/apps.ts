import type { Db } from './db.ts';
import { parseJson } from './db.ts';
import { prefixedId, randomBase62, sha256Hex } from './util/crypto.ts';
import { HttpError, str } from './util/http.ts';

export interface IosConfig {
  teamId: string | null;
  bundleIds: string[];
  appStoreId: string | null;
  /** Overrides the computed App Store URL (e.g. a TestFlight or regional link). */
  appStoreUrl: string | null;
  uriScheme: string | null;
  /** "copy_link" shows the copy-to-clipboard interstitial; "none" goes straight to the store. */
  interstitial: 'copy_link' | 'none';
  /** Used instead of the App Store when the app has no store listing yet. */
  redirectUrl: string | null;
}

export interface AndroidConfig {
  packageName: string | null;
  sha256Fingerprints: string[];
  uriScheme: string | null;
  playStoreUrl: string | null;
  redirectUrl: string | null;
}

export interface BannerConfig {
  enabled: boolean;
  title: string | null;
  subtitle: string | null;
  iconUrl: string | null;
  buttonText: string;
  dismissDays: number;
  theme: 'light' | 'dark';
}

export interface AppConfig {
  ios: IosConfig;
  android: AndroidConfig;
  desktopUrl: string | null;
  fallbackUrl: string | null;
  og: { title: string | null; description: string | null; imageUrl: string | null };
  matchWindowSec: number;
  banner: BannerConfig;
}

export interface DomainRecord {
  host: string;
  kind: 'primary' | 'alternate';
}

export interface App {
  id: string;
  name: string;
  publicKey: string;
  secretHint: string;
  config: AppConfig;
  createdAt: number;
  domains: DomainRecord[];
}

interface AppRow {
  id: string;
  name: string;
  public_key: string;
  secret_hint: string;
  config: string;
  created_at: number;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/i;
const SHA256_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => str(item)).filter((item): item is string => item !== null);
  if (typeof value === 'string') return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function url(value: unknown): string | null {
  const text = str(value, 2048);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    return parsed.toString();
  } catch {
    throw new HttpError(400, 'invalid_url', `Invalid URL: ${text}`);
  }
}

function scheme(value: unknown): string | null {
  const text = str(value, 64)?.replace(/:\/*$/, '') ?? null;
  if (text && !SCHEME_RE.test(text)) throw new HttpError(400, 'invalid_uri_scheme');
  return text;
}

function fingerprint(value: string): string {
  const hex = value.replace(/[^0-9a-f]/gi, '').toUpperCase();
  const formatted = hex.match(/.{2}/g)?.join(':') ?? '';
  if (!SHA256_RE.test(formatted)) throw new HttpError(400, 'invalid_sha256_fingerprint', `Invalid SHA-256 fingerprint: ${value}`);
  return formatted;
}

/** Validates and fills defaults; accepts partial input so PATCH can merge. */
export function normalizeConfig(input: unknown, base?: AppConfig): AppConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const ios = { ...(base?.ios ?? {}), ...(raw.ios ?? {}) } as Record<string, unknown>;
  const android = { ...(base?.android ?? {}), ...(raw.android ?? {}) } as Record<string, unknown>;
  const og = { ...(base?.og ?? {}), ...(raw.og ?? {}) } as Record<string, unknown>;
  const banner = { ...(base?.banner ?? {}), ...(raw.banner ?? {}) } as Record<string, unknown>;
  const pick = (key: string): unknown => (key in raw ? raw[key] : (base as Record<string, unknown> | undefined)?.[key]);

  const teamId = str(ios.teamId, 20)?.toUpperCase() ?? null;
  if (teamId && !/^[A-Z0-9]{10}$/.test(teamId)) throw new HttpError(400, 'invalid_team_id', 'Apple Team ID must be 10 characters');
  const appStoreId = str(ios.appStoreId, 20)?.replace(/^id/, '') ?? null;
  if (appStoreId && !/^\d+$/.test(appStoreId)) throw new HttpError(400, 'invalid_app_store_id');
  const packageName = str(android.packageName, 255);
  if (packageName && !/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(packageName)) throw new HttpError(400, 'invalid_package_name');

  const matchWindow = Number(pick('matchWindowSec') ?? 7200);
  const dismissDays = Number(banner.dismissDays ?? 7);
  return {
    ios: {
      teamId,
      bundleIds: list(ios.bundleIds),
      appStoreId,
      appStoreUrl: url(ios.appStoreUrl),
      uriScheme: scheme(ios.uriScheme),
      interstitial: ios.interstitial === 'none' ? 'none' : 'copy_link',
      redirectUrl: url(ios.redirectUrl),
    },
    android: {
      packageName,
      sha256Fingerprints: list(android.sha256Fingerprints).map(fingerprint),
      uriScheme: scheme(android.uriScheme),
      playStoreUrl: url(android.playStoreUrl),
      redirectUrl: url(android.redirectUrl),
    },
    desktopUrl: url(pick('desktopUrl')),
    fallbackUrl: url(pick('fallbackUrl')),
    og: { title: str(og.title, 300), description: str(og.description, 1000), imageUrl: url(og.imageUrl) },
    matchWindowSec: Number.isFinite(matchWindow) ? Math.min(Math.max(Math.round(matchWindow), 60), 30 * 86400) : 7200,
    banner: {
      enabled: banner.enabled === true || banner.enabled === 'true',
      title: str(banner.title, 120),
      subtitle: str(banner.subtitle, 200),
      iconUrl: url(banner.iconUrl),
      buttonText: str(banner.buttonText, 40) ?? 'Open',
      dismissDays: Number.isFinite(dismissDays) ? Math.min(Math.max(Math.round(dismissDays), 0), 365) : 7,
      theme: banner.theme === 'dark' ? 'dark' : 'light',
    },
  };
}

async function toApp(db: Db, row: AppRow): Promise<App> {
  return {
    id: row.id,
    name: row.name,
    publicKey: row.public_key,
    secretHint: row.secret_hint,
    config: normalizeConfig(parseJson(row.config, {})),
    createdAt: row.created_at,
    domains: await db.all<{ host: string; kind: 'primary' | 'alternate' }>(
      'SELECT host, kind FROM domains WHERE app_id = ? ORDER BY kind DESC, host', row.id,
    ),
  };
}

export async function createApp(db: Db, name: string, configInput: unknown): Promise<{ app: App; secretKey: string }> {
  const cleanName = str(name, 120);
  if (!cleanName) throw new HttpError(400, 'name_required');
  const config = normalizeConfig(configInput);
  const id = prefixedId('app', 16);
  const publicKey = `tw_live_${randomBase62(24)}`;
  const secretKey = `tw_secret_${randomBase62(32)}`;
  await db.run(
    'INSERT INTO apps (id, name, public_key, secret_hash, secret_hint, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, cleanName, publicKey, await sha256Hex(secretKey), secretKey.slice(-4), JSON.stringify(config), Date.now(),
  );
  return { app: (await getApp(db, id))!, secretKey };
}

export async function getApp(db: Db, id: string): Promise<App | null> {
  const row = await db.get<AppRow>('SELECT * FROM apps WHERE id = ?', id);
  return row ? await toApp(db, row) : null;
}

export async function listApps(db: Db): Promise<App[]> {
  return Promise.all((await db.all<AppRow>('SELECT * FROM apps ORDER BY created_at')).map((row) => toApp(db, row)));
}

export async function getAppByPublicKey(db: Db, key: string | null): Promise<App | null> {
  if (!key) return null;
  const row = await db.get<AppRow>('SELECT * FROM apps WHERE public_key = ?', key);
  return row ? await toApp(db, row) : null;
}

export async function getAppBySecret(db: Db, secret: string | null): Promise<App | null> {
  if (!secret || !secret.startsWith('tw_secret_')) return null;
  const row = await db.get<AppRow>('SELECT * FROM apps WHERE secret_hash = ?', await sha256Hex(secret));
  return row ? await toApp(db, row) : null;
}

export async function updateApp(db: Db, id: string, patch: { name?: unknown; config?: unknown }): Promise<App> {
  const app = await getApp(db, id);
  if (!app) throw new HttpError(404, 'app_not_found');
  const name = patch.name === undefined ? app.name : str(patch.name, 120);
  if (!name) throw new HttpError(400, 'name_required');
  const config = patch.config === undefined ? app.config : normalizeConfig(patch.config, app.config);
  await db.run('UPDATE apps SET name = ?, config = ? WHERE id = ?', name, JSON.stringify(config), id);
  return (await getApp(db, id))!;
}

export async function rotateSecret(db: Db, id: string): Promise<string> {
  const secretKey = `tw_secret_${randomBase62(32)}`;
  const result = await db.run('UPDATE apps SET secret_hash = ?, secret_hint = ? WHERE id = ?', await sha256Hex(secretKey), secretKey.slice(-4), id);
  if (result.changes === 0) throw new HttpError(404, 'app_not_found');
  return secretKey;
}

export async function deleteApp(db: Db, id: string): Promise<void> {
  await db.run('DELETE FROM apps WHERE id = ?', id);
}

export function normalizeHost(value: unknown): string {
  const host = (str(value, 253) ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!HOST_RE.test(host)) throw new HttpError(400, 'invalid_domain', `Invalid domain: ${String(value)}`);
  return host;
}

/** Replaces all domains of an app. A host can belong to only one app. */
export async function setDomains(db: Db, appId: string, domains: Array<{ host: unknown; kind?: unknown }>): Promise<DomainRecord[]> {
  const clean = domains.map((domain) => ({
    host: normalizeHost(domain.host),
    kind: (domain.kind === 'alternate' ? 'alternate' : 'primary') as DomainRecord['kind'],
  }));
  const hosts = new Set<string>();
  for (const domain of clean) {
    if (hosts.has(domain.host)) throw new HttpError(400, 'duplicate_domain', domain.host);
    hosts.add(domain.host);
    const owner = await db.get<{ app_id: string }>('SELECT app_id FROM domains WHERE host = ?', domain.host);
    if (owner && owner.app_id !== appId) throw new HttpError(409, 'domain_taken', `${domain.host} belongs to another app`);
  }
  await db.batch([
    db.statement('DELETE FROM domains WHERE app_id = ?', appId),
    ...clean.map((domain) => db.statement('INSERT INTO domains (host, app_id, kind) VALUES (?, ?, ?)', domain.host, appId, domain.kind)),
  ]);
  return (await getApp(db, appId))!.domains;
}

export async function appForHost(db: Db, host: string): Promise<{ app: App; kind: 'primary' | 'alternate' } | null> {
  const row = await db.get<{ app_id: string; kind: 'primary' | 'alternate' }>('SELECT app_id, kind FROM domains WHERE host = ?', host);
  if (!row) return null;
  const app = await getApp(db, row.app_id);
  return app ? { app, kind: row.kind } : null;
}

export function primaryHost(app: App): string | null {
  return app.domains.find((domain) => domain.kind === 'primary')?.host ?? null;
}

export function alternateHost(app: App): string | null {
  return app.domains.find((domain) => domain.kind === 'alternate')?.host ?? null;
}

export function appStoreUrl(app: App): string | null {
  const ios = app.config.ios;
  if (ios.appStoreUrl) return ios.appStoreUrl;
  if (ios.appStoreId) return `https://apps.apple.com/app/id${ios.appStoreId}`;
  return null;
}
