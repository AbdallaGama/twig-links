import { isIP } from 'node:net';
import type { App } from './apps.ts';
import { appForHost } from './apps.ts';
import type { Db } from './db.ts';
import { parseJson } from './db.ts';
import type { LinkData, ResolvedLink } from './links.ts';
import { publicLinkData, resolvePath } from './links.ts';
import { MATCH_PARAM } from './routing.ts';
import type { ClientInfo } from './ua.ts';
import { majorMinor } from './ua.ts';
import { hmacHex, newClickId } from './util/crypto.ts';

export type MatchType = 'click_id' | 'universal_link' | 'uri_scheme' | 'install_referrer' | 'pasteboard' | 'web_match_id' | 'fingerprint';

export interface ClickRecord {
  id: string;
  app_id: string;
  link_id: number | null;
  link_data: string;
  link_url: string;
  created_at: number;
  match_window_sec: number;
  ip_hash: string | null;
  ip_prefix_hash: string | null;
  os: string | null;
  os_version: string | null;
  model: string | null;
  language: string | null;
  browser_id: string | null;
  claimed_at: number | null;
  claimed_by: string | null;
}

export interface Attribution {
  matchType: MatchType;
  guaranteed: boolean;
  data: LinkData;
  linkId: number | null;
  clickId: string | null;
  clickedAt: number | null;
  url: string | null;
}

/** IPv4 → /24, IPv6 → /64. Carrier NAT and IPv6 privacy addresses make the prefix useful. */
export function ipPrefix(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return ip.split('.').slice(0, 3).join('.');
  if (version === 6) {
    const [head = '', tail = ''] = ip.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const full = ip.includes('::') ? [...left, ...new Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return full.slice(0, 4).map((part) => part.toLowerCase().replace(/^0+(?=.)/, '')).join(':');
  }
  return null;
}

export function ipHashes(secret: string, ip: string): { ipHash: string | null; prefixHash: string | null } {
  if (!ip) return { ipHash: null, prefixHash: null };
  const prefix = ipPrefix(ip);
  return { ipHash: hmacHex(secret, `ip:${ip}`), prefixHash: prefix ? hmacHex(secret, `prefix:${prefix}`) : null };
}

export interface RecordClickInput {
  app: App;
  resolved: ResolvedLink;
  client: ClientInfo;
  ip: string;
  language: string | null;
  country: string | null;
  browserId: string | null;
  referrer: string | null;
  route: string;
  linkUrl: string;
  secret: string;
}

export function recordClick(db: Db, input: RecordClickInput): string {
  const id = newClickId();
  const { ipHash, prefixHash } = ipHashes(input.secret, input.ip);
  const windowOverride = Number(input.resolved.data.$match_duration);
  const matchWindow = Number.isFinite(windowOverride) && windowOverride > 0 ? Math.min(windowOverride, 30 * 86400) : input.app.config.matchWindowSec;
  db.run(
    `INSERT INTO clicks (id, app_id, link_id, link_data, link_url, created_at, match_window_sec, ip_hash, ip_prefix_hash,
       os, os_version, model, browser, in_app, language, country, browser_id, referrer, route)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.app.id, input.resolved.link?.id ?? null, JSON.stringify(publicLinkData(input.resolved)), input.linkUrl, Date.now(), matchWindow,
    ipHash, prefixHash, input.client.platform, input.client.osVersion, input.client.model, input.client.browser, input.client.inApp,
    input.language, input.country, input.browserId, input.referrer?.slice(0, 1024) ?? null, input.route,
  );
  return id;
}

export function updateClickRoute(db: Db, clickId: string, route: string): void {
  db.run('UPDATE clicks SET route = ? WHERE id = ?', route, clickId);
}

function getClick(db: Db, appId: string, clickId: string): ClickRecord | undefined {
  return db.get<ClickRecord>('SELECT * FROM clicks WHERE id = ? AND app_id = ?', clickId, appId);
}

function attributionFromClick(click: ClickRecord, matchType: MatchType, guaranteed: boolean): Attribution {
  return {
    matchType,
    guaranteed,
    data: parseJson<LinkData>(click.link_data, {}),
    linkId: click.link_id,
    clickId: click.id,
    clickedAt: click.created_at,
    url: click.link_url,
  };
}

function claim(db: Db, click: ClickRecord, deviceId: string): void {
  db.run('UPDATE clicks SET claimed_at = COALESCE(claimed_at, ?), claimed_by = COALESCE(claimed_by, ?) WHERE id = ?', Date.now(), deviceId, click.id);
}

function parseUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Extracts a click id from link_click_id=… or _twig_match_id=… in a query-like string. */
export function clickIdFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  const params = new URLSearchParams(text.includes('?') ? text.slice(text.indexOf('?') + 1).split('#')[0] : text);
  const id = params.get('link_click_id') ?? params.get(MATCH_PARAM);
  return id && /^\d{10,30}$/.test(id) ? id : null;
}

/**
 * Resolves a URL that opened the app (Universal Link, App Link, URI scheme or pasteboard
 * content). Returns null for URLs that do not belong to this app.
 */
function attributeUrl(db: Db, app: App, rawUrl: string, matchType: MatchType, deviceId: string, maxClickAgeMs: number | null): Attribution | null {
  const url = parseUrl(rawUrl);
  if (!url) return null;

  const clickId = clickIdFrom(url.search);
  if (clickId) {
    const click = getClick(db, app.id, clickId);
    if (click && (maxClickAgeMs === null || Date.now() - click.created_at <= maxClickAgeMs)) {
      claim(db, click, deviceId);
      return attributionFromClick(click, matchType === 'uri_scheme' ? 'click_id' : matchType, true);
    }
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const owner = appForHost(db, url.hostname.toLowerCase());
    if (!owner || owner.app.id !== app.id) return null;
    if (matchType === 'pasteboard') return null; // pasteboard links must carry a click id
    const resolved = resolvePath(db, app, url.pathname, url.searchParams, canonicalUrl(url));
    if (!resolved) return null;
    return { matchType, guaranteed: true, data: publicLinkData(resolved), linkId: resolved.link?.id ?? null, clickId: null, clickedAt: null, url: resolved.url };
  }
  return null;
}

export function canonicalUrl(url: URL): string {
  const copy = new URL(url.toString());
  for (const key of ['link_click_id', MATCH_PARAM, '__twig_flow', '_cpts']) copy.searchParams.delete(key);
  copy.hash = '';
  return copy.toString();
}

export interface FingerprintInput {
  platform: string | null;
  osVersion: string | null;
  model: string | null;
  language: string | null;
  ip: string;
}

/**
 * Probabilistic matching for clicks without a deterministic signal. Requires the same
 * platform and IP (exact or prefix) inside the click's match window, then scores OS
 * version, model, language and recency. Never "guaranteed".
 */
export function fingerprintMatch(db: Db, app: App, input: FingerprintInput, secret: string, deviceId: string, notBefore: number | null = null, now = Date.now()): Attribution | null {
  const { ipHash, prefixHash } = ipHashes(secret, input.ip);
  if (!ipHash) return null;
  const since = Math.max(now - 30 * 86400 * 1000, notBefore ?? 0);
  const candidates = db.all<ClickRecord>(
    `SELECT * FROM clicks WHERE app_id = ? AND claimed_at IS NULL AND created_at >= ?
       AND (ip_hash = ? OR (ip_prefix_hash IS NOT NULL AND ip_prefix_hash = ?))
     ORDER BY created_at DESC LIMIT 50`,
    app.id, since, ipHash, prefixHash,
  );
  const platform = input.platform?.toLowerCase() ?? null;
  const osVersion = majorMinor(input.osVersion);
  const model = input.model?.toLowerCase() ?? null;
  const language = input.language?.slice(0, 2).toLowerCase() ?? null;

  let best: { click: ClickRecord; score: number } | null = null;
  for (const click of candidates) {
    const age = now - click.created_at;
    if (age < 0 || age > click.match_window_sec * 1000) continue;
    if (platform && click.os && click.os !== platform) continue;
    let score = click.ip_hash === ipHash ? 50 : 30;
    const clickVersion = majorMinor(click.os_version);
    if (osVersion && clickVersion) score += osVersion === clickVersion ? 20 : -25;
    if (model && click.model) {
      const clickModel = click.model.toLowerCase();
      if (clickModel === model || model.startsWith(clickModel) || clickModel.startsWith(model)) score += 10;
    }
    if (language && click.language && click.language.slice(0, 2).toLowerCase() === language) score += 5;
    score += 10 * (1 - age / (click.match_window_sec * 1000));
    if (!best || score > best.score) best = { click, score };
  }
  if (!best || best.score < 45) return null;
  claim(db, best.click, deviceId);
  return attributionFromClick(best.click, 'fingerprint', false);
}

export interface AttributeInput {
  linkUrl: string | null;
  linkClickId: string | null;
  installReferrer: string | null;
  pasteboardUrl: string | null;
  isFirstSession: boolean;
  fingerprint: FingerprintInput;
  /** Only match fingerprints when the app was opened without any URL. */
  allowFingerprint: boolean;
  /** For regular opens, only clicks made after the device was last seen are eligible. */
  fingerprintNotBefore: number | null;
}

/** Applies every signal in order of determinism. */
export function attribute(db: Db, app: App, input: AttributeInput, secret: string, deviceId: string): Attribution | null {
  if (input.linkClickId && /^\d{10,30}$/.test(input.linkClickId)) {
    const click = getClick(db, app.id, input.linkClickId);
    if (click) {
      claim(db, click, deviceId);
      return attributionFromClick(click, 'click_id', true);
    }
  }
  if (input.linkUrl) {
    const isScheme = !/^https?:/i.test(input.linkUrl);
    const result = attributeUrl(db, app, input.linkUrl, isScheme ? 'uri_scheme' : 'universal_link', deviceId, null);
    if (result) return result;
  }
  if (input.installReferrer && input.isFirstSession) {
    const clickId = clickIdFrom(input.installReferrer);
    const click = clickId ? getClick(db, app.id, clickId) : undefined;
    if (click) {
      claim(db, click, deviceId);
      return attributionFromClick(click, 'install_referrer', true);
    }
  }
  if (input.pasteboardUrl && input.isFirstSession) {
    const result = attributeUrl(db, app, input.pasteboardUrl, 'pasteboard', deviceId, app.config.matchWindowSec * 1000 * 12);
    if (result) return result;
  }
  if (input.allowFingerprint && !input.linkUrl) {
    return fingerprintMatch(db, app, input.fingerprint, secret, deviceId, input.fingerprintNotBefore);
  }
  return null;
}

/** Web SDK: _twig_match_id from the landing URL, or the newest click from the same browser cookie. */
export function attributeWeb(db: Db, app: App, matchId: string | null, browserId: string | null, deviceId: string): Attribution | null {
  if (matchId && /^\d{10,30}$/.test(matchId)) {
    const click = getClick(db, app.id, matchId);
    if (click) {
      claim(db, click, deviceId);
      return attributionFromClick(click, 'web_match_id', true);
    }
  }
  if (browserId) {
    const click = db.get<ClickRecord>(
      'SELECT * FROM clicks WHERE app_id = ? AND browser_id = ? AND claimed_at IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
      app.id, browserId, Date.now() - app.config.matchWindowSec * 1000,
    );
    if (click) {
      claim(db, click, deviceId);
      return attributionFromClick(click, 'web_match_id', true);
    }
  }
  return null;
}

export function tagsFromData(data: LinkData): { channel: string | null; feature: string | null; campaign: string | null } {
  const pick = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : null);
  return { channel: pick('~channel'), feature: pick('~feature'), campaign: pick('~campaign') };
}

export function purgeOldClicks(db: Db, retentionDays: number): number {
  return db.run('DELETE FROM clicks WHERE created_at < ?', Date.now() - retentionDays * 86400 * 1000).changes;
}
