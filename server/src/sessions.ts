import type { App } from './apps.ts';
import { appForHost } from './apps.ts';
import type { Db } from './db.ts';
import { parseJson } from './db.ts';
import { logEvent, STANDARD_EVENTS } from './events.ts';
import type { LinkData } from './links.ts';
import type { Attribution } from './matching.ts';
import { attribute, attributeWeb, tagsFromData } from './matching.ts';
import { prefixedId, randomBase62 } from './util/crypto.ts';
import { bool, HttpError, obj, str } from './util/http.ts';

interface DeviceRow {
  id: string;
  app_id: string;
  hardware_id: string | null;
  identity: string | null;
  last_seen: number;
  last_touch_data: string | null;
  last_touch_at: number | null;
}

/** Attribution window for in-app events after the last link touch. */
const EVENT_ATTRIBUTION_WINDOW_MS = 30 * 86400 * 1000;

function findDevice(db: Db, app: App, token: string | null, hardwareId: string | null): DeviceRow | undefined {
  if (token) {
    const byToken = db.get<DeviceRow>('SELECT * FROM devices WHERE id = ? AND app_id = ?', token, app.id);
    if (byToken) return byToken;
  }
  if (hardwareId) {
    return db.get<DeviceRow>('SELECT * FROM devices WHERE app_id = ? AND hardware_id = ? ORDER BY last_seen DESC LIMIT 1', app.id, hardwareId);
  }
  return undefined;
}

function systemData(attribution: Attribution | null, isFirstSession: boolean): LinkData {
  if (!attribution) return { '+clicked_link': false, '+is_first_session': isFirstSession };
  return {
    ...attribution.data,
    '+clicked_link': true,
    '+is_first_session': isFirstSession,
    '+match_guaranteed': attribution.guaranteed,
    '+match_type': attribution.matchType,
    ...(attribution.clickedAt ? { '+click_timestamp': Math.floor(attribution.clickedAt / 1000) } : {}),
  };
}

export interface OpenResult {
  session_id: string;
  device_token: string;
  identity: string | null;
  data: LinkData;
}

/**
 * POST /v1/open — called by the mobile SDKs on every launch and whenever the app is
 * opened by a link. The first launch after install is flagged with is_first_launch.
 */
export function handleOpen(db: Db, app: App, body: Record<string, unknown>, ip: string, secret: string): OpenResult {
  const hardwareId = str(body.hardware_id, 128);
  const isFirstLaunch = bool(body.is_first_launch);
  const existing = findDevice(db, app, str(body.device_token, 64), hardwareId);
  const now = Date.now();
  const deviceId = existing?.id ?? prefixedId('dv', 20);
  const platform = str(body.os, 32)?.toLowerCase() ?? null;
  const kind = isFirstLaunch ? (existing ? 'reinstall' : 'install') : 'open';
  const linkUrl = str(body.link_url, 4096);

  const attribution = attribute(db, app, {
    linkUrl,
    linkClickId: str(body.link_click_id, 32),
    installReferrer: str(body.install_referrer, 2048),
    pasteboardUrl: str(body.pasteboard_url, 4096),
    isFirstSession: isFirstLaunch,
    allowFingerprint: true,
    fingerprintNotBefore: isFirstLaunch || !existing ? null : existing.last_seen,
    fingerprint: {
      platform,
      osVersion: str(body.os_version, 32),
      model: str(body.model, 64),
      language: str(body.locale, 16)?.replace('_', '-') ?? null,
      ip,
    },
  }, secret, deviceId);

  const data = systemData(attribution, isFirstLaunch);
  if (linkUrl && !attribution && /^https?:/i.test(linkUrl)) {
    // Opened by a URL that is not a Twig link (e.g. the website domain): hand it to the app.
    try {
      const host = new URL(linkUrl).hostname.toLowerCase();
      if (!appForHost(db, host)) data['+non_twig_link'] = linkUrl;
    } catch { /* ignore malformed URL */ }
  }

  const identity = str(body.identity, 256) ?? existing?.identity ?? null;
  const touchData = attribution ? JSON.stringify(attribution.data) : null;
  if (existing) {
    db.run(
      `UPDATE devices SET hardware_id = COALESCE(?, hardware_id), platform = ?, os_version = ?, model = ?, brand = ?, app_version = ?, sdk = ?,
         identity = ?, last_seen = ?, last_touch_data = COALESCE(?, last_touch_data), last_touch_at = CASE WHEN ? IS NULL THEN last_touch_at ELSE ? END
       WHERE id = ?`,
      hardwareId, platform, str(body.os_version, 32), str(body.model, 64), str(body.brand, 64), str(body.app_version, 32), str(body.sdk, 64),
      identity, now, touchData, touchData, now, deviceId,
    );
  } else {
    db.run(
      `INSERT INTO devices (id, app_id, hardware_id, platform, os_version, model, brand, app_version, sdk, identity, first_seen, last_seen,
         install_link_id, install_data, last_touch_data, last_touch_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      deviceId, app.id, hardwareId, platform, str(body.os_version, 32), str(body.model, 64), str(body.brand, 64), str(body.app_version, 32),
      str(body.sdk, 64), identity, now, now, attribution?.linkId ?? null, touchData, touchData, attribution ? now : null,
    );
  }

  const tags = attribution ? tagsFromData(attribution.data) : { channel: null, feature: null, campaign: null };
  logEvent(db, {
    appId: app.id,
    kind,
    name: kind.toUpperCase(),
    linkId: attribution?.linkId ?? null,
    clickId: attribution?.clickId ?? null,
    deviceId,
    identity,
    ...tags,
    platform,
    data: attribution ? { match_type: attribution.matchType, match_guaranteed: attribution.guaranteed } : null,
  });

  return { session_id: `se_${randomBase62(20)}`, device_token: deviceId, identity, data };
}

/** POST /v1/web/open — Web SDK session start on a website after a link redirect. */
export function handleWebOpen(db: Db, app: App, body: Record<string, unknown>): OpenResult {
  let browserToken = str(body.browser_token, 64);
  if (!browserToken || !browserToken.startsWith('wb_')) browserToken = prefixedId('wb', 20);
  const existing = db.get<DeviceRow>('SELECT * FROM devices WHERE id = ? AND app_id = ?', browserToken, app.id);
  const attribution = attributeWeb(db, app, str(body.match_id, 32), null, browserToken);
  const now = Date.now();
  const touchData = attribution ? JSON.stringify(attribution.data) : null;
  const identity = str(body.identity, 256) ?? existing?.identity ?? null;
  if (existing) {
    db.run('UPDATE devices SET last_seen = ?, identity = ?, last_touch_data = COALESCE(?, last_touch_data), last_touch_at = CASE WHEN ? IS NULL THEN last_touch_at ELSE ? END WHERE id = ?',
      now, identity, touchData, touchData, now, browserToken);
  } else {
    db.run(`INSERT INTO devices (id, app_id, platform, sdk, identity, first_seen, last_seen, install_link_id, install_data, last_touch_data, last_touch_at)
            VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?)`,
      browserToken, app.id, str(body.sdk, 64), identity, now, now, attribution?.linkId ?? null, touchData, touchData, attribution ? now : null);
  }
  if (attribution) {
    logEvent(db, {
      appId: app.id, kind: 'web_open', name: 'WEB_OPEN', linkId: attribution.linkId, clickId: attribution.clickId,
      deviceId: browserToken, identity, platform: 'web', ...tagsFromData(attribution.data),
      data: { url: str(body.url, 2048), referrer: str(body.referrer, 2048) },
    });
  }
  return { session_id: `se_${randomBase62(20)}`, device_token: browserToken, identity, data: systemData(attribution, !existing) };
}

function requireDevice(db: Db, app: App, token: string | null): DeviceRow {
  const device = token ? db.get<DeviceRow>('SELECT * FROM devices WHERE id = ? AND app_id = ?', token, app.id) : undefined;
  if (!device) throw new HttpError(400, 'unknown_device', 'Call /v1/open first and send the returned device_token');
  return device;
}

/** POST /v1/event — standard (PURCHASE, ...) or custom events, attributed to the last link touch. */
export function handleEvent(db: Db, app: App, body: Record<string, unknown>): { ok: true; event_id: number; attributed: boolean } {
  const name = str(body.name, 128);
  if (!name) throw new HttpError(400, 'name_required');
  const device = requireDevice(db, app, str(body.device_token, 64));
  const fresh = device.last_touch_at !== null && Date.now() - device.last_touch_at <= EVENT_ATTRIBUTION_WINDOW_MS;
  const touch = fresh ? parseJson<LinkData>(device.last_touch_data, {}) : {};
  const linkId = typeof touch['~id'] === 'string' ? Number(touch['~id']) : null;
  const revenue = Number(body.revenue);
  const custom = obj(body.data);
  const contentItems = Array.isArray(body.content_items) ? body.content_items.slice(0, 50) : undefined;
  const eventId = logEvent(db, {
    appId: app.id,
    kind: 'event',
    name: STANDARD_EVENTS.has(name.toUpperCase()) ? name.toUpperCase() : name,
    linkId: Number.isFinite(linkId) ? linkId : null,
    deviceId: device.id,
    identity: device.identity,
    ...tagsFromData(touch),
    platform: str(body.os, 32)?.toLowerCase() ?? null,
    revenue: Number.isFinite(revenue) ? revenue : null,
    currency: str(body.currency, 8)?.toUpperCase() ?? null,
    data: { ...custom, ...(contentItems ? { content_items: contentItems } : {}), ...(str(body.alias, 128) ? { alias: str(body.alias, 128) } : {}) },
  });
  return { ok: true, event_id: eventId, attributed: Object.keys(touch).length > 0 };
}

/** POST /v1/identity — associates (or clears, with identity=null) a developer user id. */
export function handleIdentity(db: Db, app: App, body: Record<string, unknown>): { ok: true; identity: string | null } {
  const device = requireDevice(db, app, str(body.device_token, 64));
  const identity = str(body.identity, 256);
  db.run('UPDATE devices SET identity = ? WHERE id = ?', identity, device.id);
  return { ok: true, identity };
}
