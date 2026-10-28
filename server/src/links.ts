import type { App } from './apps.ts';
import { primaryHost } from './apps.ts';
import type { Db } from './db.ts';
import { parseJson } from './db.ts';
import { randomBase62, sha256Hex } from './util/crypto.ts';
import { HttpError, str } from './util/http.ts';

/**
 * Link data uses three key families, mirroring the conventions mobile teams already know:
 *   $key  control parameters that change routing ($deeplink_path, $ios_url, $web_only, ...)
 *   ~key  analytics tags (~channel, ~feature, ~campaign, ~stage, ~tags) — added on read
 *   +key  system values returned to the app (+clicked_link, +is_first_session, ...)
 * Everything else is free-form custom data delivered to the app.
 */
export type LinkData = Record<string, unknown>;

export interface LinkTags {
  channel: string | null;
  feature: string | null;
  campaign: string | null;
  stage: string | null;
  tags: string[];
}

export interface StoredLink extends LinkTags {
  id: number;
  appId: string;
  code: string;
  data: LinkData;
  isAlias: boolean;
  source: string;
  disabled: boolean;
  createdAt: number;
}

/** A link resolved from an incoming URL: either a stored short link or a long link. */
export interface ResolvedLink {
  link: StoredLink | null;
  data: LinkData;
  tags: LinkTags;
  url: string;
}

interface LinkRow {
  id: number;
  app_id: string;
  code: string;
  data: string;
  channel: string | null;
  feature: string | null;
  campaign: string | null;
  stage: string | null;
  tags: string | null;
  is_alias: number;
  source: string;
  disabled: number;
  created_at: number;
}

/** First path segments that can never be short codes or aliases. */
export const RESERVED_PATHS = new Set([
  '', '.well-known', 'apple-app-site-association', 'a', 'e', 'v1', 'api', 'dashboard', 'sdk', 'qr',
  'healthz', 'favicon.ico', 'robots.txt', 'assets',
]);

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
const TAG_KEYS = ['channel', 'feature', 'campaign', 'stage', 'tags'] as const;
const MAX_DATA_BYTES = 16 * 1024;

function toLink(row: LinkRow): StoredLink {
  return {
    id: row.id,
    appId: row.app_id,
    code: row.code,
    data: parseJson<LinkData>(row.data, {}),
    channel: row.channel,
    feature: row.feature,
    campaign: row.campaign,
    stage: row.stage,
    tags: parseJson<string[]>(row.tags, []),
    isAlias: row.is_alias === 1,
    source: row.source,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}

export function normalizeTags(input: Record<string, unknown>): LinkTags {
  const tagsValue = input.tags ?? input['~tags'];
  let tags: string[] = [];
  if (Array.isArray(tagsValue)) tags = tagsValue.map((tag) => str(tag, 64)).filter((tag): tag is string => tag !== null);
  else if (typeof tagsValue === 'string') tags = tagsValue.split(',').map((tag) => tag.trim()).filter(Boolean);
  const pick = (key: string) => str(input[key] ?? input[`~${key}`], 128);
  return { channel: pick('channel'), feature: pick('feature'), campaign: pick('campaign'), stage: pick('stage'), tags: tags.slice(0, 20) };
}

export function normalizeData(input: unknown): LinkData {
  const data: LinkData = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      // System (+) and analytics (~) keys are owned by the server.
      if (key.startsWith('+') || key.startsWith('~') || key.length > 128) continue;
      data[key] = value;
    }
  }
  if (new TextEncoder().encode(JSON.stringify(data)).length > MAX_DATA_BYTES) throw new HttpError(413, 'link_data_too_large');
  return data;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface CreateLinkInput {
  data?: unknown;
  alias?: unknown;
  channel?: unknown;
  feature?: unknown;
  campaign?: unknown;
  stage?: unknown;
  tags?: unknown;
  source: 'sdk' | 'api' | 'dashboard';
  /** SDK links with identical content are reused instead of creating duplicates. */
  dedupe?: boolean;
}

export async function createLink(db: Db, app: App, input: CreateLinkInput): Promise<StoredLink> {
  const data = normalizeData(input.data);
  const tags = normalizeTags({ ...input });
  const alias = str(input.alias, 128);
  const dedupeHash = alias ? null : await sha256Hex(canonical({ data, ...tags }));

  if (alias) {
    if (!ALIAS_RE.test(alias) || RESERVED_PATHS.has(alias.toLowerCase())) throw new HttpError(400, 'invalid_alias');
    const existing = await db.get<LinkRow>('SELECT * FROM links WHERE app_id = ? AND code = ?', app.id, alias);
    if (existing) {
      const link = toLink(existing);
      if (canonical(link.data) === canonical(data)) return link;
      // The same destination may refresh its preview (name, image) and tags:
      // a product keeps one readable link while its details change.
      const destination = data.$deeplink_path;
      if (typeof destination === 'string' && destination !== '' && link.data.$deeplink_path === destination) {
        return updateLink(db, link, { ...tags, data });
      }
      throw new HttpError(409, 'alias_taken', `Alias "${alias}" is already used with different data`);
    }
  } else if (input.dedupe) {
    const existing = await db.get<LinkRow>('SELECT * FROM links WHERE app_id = ? AND dedupe_hash = ? AND disabled = 0 ORDER BY id LIMIT 1', app.id, dedupeHash);
    if (existing) return toLink(existing);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = alias ?? randomBase62(attempt < 3 ? 9 : 12);
    try {
      const result = await db.run(
        `INSERT INTO links (app_id, code, data, channel, feature, campaign, stage, tags, is_alias, dedupe_hash, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        app.id, code, JSON.stringify(data), tags.channel, tags.feature, tags.campaign, tags.stage,
        JSON.stringify(tags.tags), alias ? 1 : 0, dedupeHash, input.source, Date.now(),
      );
      return (await getLinkById(db, result.lastInsertRowid))!;
    } catch (error) {
      if (alias || !String(error).includes('UNIQUE')) throw error;
    }
  }
  throw new HttpError(500, 'code_generation_failed');
}

export async function getLinkById(db: Db, id: number): Promise<StoredLink | null> {
  const row = await db.get<LinkRow>('SELECT * FROM links WHERE id = ?', id);
  return row ? toLink(row) : null;
}

export async function getLinkByCode(db: Db, appId: string, code: string): Promise<StoredLink | null> {
  const row = await db.get<LinkRow>('SELECT * FROM links WHERE app_id = ? AND code = ?', appId, code);
  return row ? toLink(row) : null;
}

export async function listLinks(db: Db, appId: string, options: { limit?: number; offset?: number; search?: string | null } = {}): Promise<StoredLink[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  if (options.search) {
    const like = `%${options.search}%`;
    return (await db.all<LinkRow>(
      `SELECT * FROM links WHERE app_id = ? AND (code LIKE ? OR data LIKE ? OR campaign LIKE ? OR channel LIKE ?)
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      appId, like, like, like, like, limit, offset,
    )).map(toLink);
  }
  return (await db.all<LinkRow>('SELECT * FROM links WHERE app_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', appId, limit, offset)).map(toLink);
}

export async function updateLink(db: Db, link: StoredLink, patch: Record<string, unknown>): Promise<StoredLink> {
  const data = patch.data === undefined ? link.data : normalizeData(patch.data);
  const tags = normalizeTags({ ...link, ...patch, tags: patch.tags ?? link.tags });
  const disabled = patch.disabled === undefined ? link.disabled : patch.disabled === true;
  await db.run(
    'UPDATE links SET data = ?, channel = ?, feature = ?, campaign = ?, stage = ?, tags = ?, disabled = ?, dedupe_hash = NULL WHERE id = ?',
    JSON.stringify(data), tags.channel, tags.feature, tags.campaign, tags.stage, JSON.stringify(tags.tags), disabled, link.id,
  );
  return (await getLinkById(db, link.id))!;
}

export async function deleteLink(db: Db, link: StoredLink): Promise<void> {
  await db.run('DELETE FROM links WHERE id = ?', link.id);
}

export function linkUrl(app: App, link: StoredLink, fallbackBase: string): string {
  const host = primaryHost(app);
  return `${host ? `https://${host}` : fallbackBase}/${encodeURIComponent(link.code)}`;
}

/**
 * Builds a long link: all data travels in the query string, no API call needed.
 * SDKs use the same format offline; the router decodes it in resolveLongLink().
 */
export function longLinkUrl(base: string, data: LinkData, tags: Partial<LinkTags> = {}): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(data)) {
    url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  for (const key of TAG_KEYS) {
    const value = tags[key];
    if (Array.isArray(value)) { if (value.length) url.searchParams.set(`~${key}`, value.join(',')); }
    else if (value) url.searchParams.set(`~${key}`, value);
  }
  return url.toString();
}

/** Query keys added by our own routing flows; never part of link data. */
const FLOW_KEYS = new Set(['link_click_id', '_twig_match_id', '__twig_flow', '_cpts', 'nl_opt_in', 'nl_opt_out', '_t']);

export function dataFromQuery(query: URLSearchParams): { data: LinkData; tags: LinkTags } {
  const data: LinkData = {};
  const tagInput: Record<string, unknown> = {};
  for (const [key, value] of query) {
    if (FLOW_KEYS.has(key)) continue;
    if (key.startsWith('~')) { tagInput[key.slice(1)] = value; continue; }
    if (key.startsWith('+')) continue;
    data[key] = value;
  }
  return { data, tags: normalizeTags(tagInput) };
}

/**
 * Resolves the link behind a request path on one of the app's domains.
 * Short link: /<code>; long link: / or /a/<public key> with data in the query string.
 * Query parameters on a short link override its stored $-control values (useful for
 * per-share tweaks such as ?$web_only=true).
 */
export async function resolvePath(db: Db, app: App, path: string, query: URLSearchParams, url: string): Promise<ResolvedLink | null> {
  const segments = path.split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  if (segments.length === 0 || (segments[0] === 'a' && segments[1] === app.publicKey && segments.length === 2)) {
    const { data, tags } = dataFromQuery(query);
    return { link: null, data, tags, url };
  }
  // `/p/<code>` is the readable product form used by websites that redirect
  // their `/p/*` paths here (e.g. water.fabric.digital/p/fiji-water).
  const code = segments.length === 2 && segments[0] === 'p' ? segments[1]! : segments.length === 1 ? segments[0]! : null;
  if (code === null || (segments.length === 1 && RESERVED_PATHS.has(code.toLowerCase()))) return null;
  const link = await getLinkByCode(db, app.id, code);
  if (!link || link.disabled) return null;
  const overrides = dataFromQuery(query).data;
  const data = { ...link.data };
  for (const [key, value] of Object.entries(overrides)) if (key.startsWith('$')) data[key] = value;
  return { link, data, tags: link, url };
}

/** Data delivered to apps: custom data plus analytics tags (~) and the link URL. */
export function publicLinkData(resolved: ResolvedLink): LinkData {
  const out: LinkData = { ...resolved.data };
  if (resolved.tags.channel) out['~channel'] = resolved.tags.channel;
  if (resolved.tags.feature) out['~feature'] = resolved.tags.feature;
  if (resolved.tags.campaign) out['~campaign'] = resolved.tags.campaign;
  if (resolved.tags.stage) out['~stage'] = resolved.tags.stage;
  if (resolved.tags.tags.length) out['~tags'] = resolved.tags.tags;
  if (resolved.link) out['~id'] = String(resolved.link.id);
  out['~referring_link'] = resolved.url;
  return out;
}
