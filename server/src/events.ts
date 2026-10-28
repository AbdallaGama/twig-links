import type { Db } from './db.ts';
import { parseJson } from './db.ts';
import { hmacHex, prefixedId, randomToken } from './util/crypto.ts';
import { HttpError, str } from './util/http.ts';

export type EventKind = 'click' | 'install' | 'reinstall' | 'open' | 'web_open' | 'event' | 'link_created';

export const WEBHOOK_EVENTS: EventKind[] = ['click', 'install', 'reinstall', 'open', 'web_open', 'event', 'link_created'];

/** Standard event names understood by the dashboard's revenue and funnel views. */
export const STANDARD_EVENTS = new Set([
  'ADD_TO_CART', 'ADD_TO_WISHLIST', 'VIEW_CART', 'INITIATE_PURCHASE', 'ADD_PAYMENT_INFO', 'PURCHASE', 'SPEND_CREDITS',
  'SUBSCRIBE', 'START_TRIAL', 'CLICK_AD', 'VIEW_AD', 'SEARCH', 'VIEW_ITEM', 'VIEW_ITEMS', 'RATE', 'SHARE',
  'COMPLETE_REGISTRATION', 'COMPLETE_TUTORIAL', 'ACHIEVE_LEVEL', 'UNLOCK_ACHIEVEMENT', 'INVITE', 'LOGIN', 'RESERVE',
  'OPT_IN', 'OPT_OUT',
]);

export interface EventInput {
  appId: string;
  kind: EventKind;
  name: string;
  linkId?: number | null;
  clickId?: string | null;
  deviceId?: string | null;
  identity?: string | null;
  channel?: string | null;
  feature?: string | null;
  campaign?: string | null;
  platform?: string | null;
  revenue?: number | null;
  currency?: string | null;
  data?: Record<string, unknown> | null;
}

export function logEvent(db: Db, input: EventInput): number {
  const createdAt = Date.now();
  const result = db.run(
    `INSERT INTO events (app_id, kind, name, link_id, click_id, device_id, identity, channel, feature, campaign, platform, revenue, currency, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.appId, input.kind, input.name, input.linkId ?? null, input.clickId ?? null, input.deviceId ?? null, input.identity ?? null,
    input.channel ?? null, input.feature ?? null, input.campaign ?? null, input.platform ?? null,
    input.revenue ?? null, input.currency ?? null, input.data ? JSON.stringify(input.data) : null, createdAt,
  );
  enqueueWebhooks(db, input.appId, input.kind, {
    id: result.lastInsertRowid,
    event: input.kind,
    name: input.name,
    app_id: input.appId,
    timestamp: new Date(createdAt).toISOString(),
    link_id: input.linkId ?? null,
    click_id: input.clickId ?? null,
    device_id: input.deviceId ?? null,
    identity: input.identity ?? null,
    channel: input.channel ?? null,
    feature: input.feature ?? null,
    campaign: input.campaign ?? null,
    platform: input.platform ?? null,
    revenue: input.revenue ?? null,
    currency: input.currency ?? null,
    data: input.data ?? null,
  });
  return result.lastInsertRowid;
}

// ---------------------------------------------------------------- webhooks

export interface Webhook {
  id: string;
  appId: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  createdAt: number;
}

interface WebhookRow {
  id: string;
  app_id: string;
  url: string;
  events: string;
  secret: string;
  active: number;
  created_at: number;
}

function toWebhook(row: WebhookRow): Webhook {
  return { id: row.id, appId: row.app_id, url: row.url, events: parseJson<string[]>(row.events, []), secret: row.secret, active: row.active === 1, createdAt: row.created_at };
}

function validateWebhookInput(input: Record<string, unknown>): { url: string; events: string[] } {
  const url = str(input.url, 2048);
  if (!url || !/^https?:\/\//i.test(url)) throw new HttpError(400, 'invalid_webhook_url');
  const raw = Array.isArray(input.events) ? input.events : ['*'];
  const events = raw.map(String).filter((name) => name === '*' || (WEBHOOK_EVENTS as string[]).includes(name));
  return { url, events: events.length ? events : ['*'] };
}

export function createWebhook(db: Db, appId: string, input: Record<string, unknown>): Webhook {
  const { url, events } = validateWebhookInput(input);
  const id = prefixedId('wh', 16);
  db.run('INSERT INTO webhooks (id, app_id, url, events, secret, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    id, appId, url, JSON.stringify(events), `whsec_${randomToken(24)}`, Date.now());
  return toWebhook(db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = ?', id)!);
}

export function listWebhooks(db: Db, appId: string): Webhook[] {
  return db.all<WebhookRow>('SELECT * FROM webhooks WHERE app_id = ? ORDER BY created_at', appId).map(toWebhook);
}

export function updateWebhook(db: Db, appId: string, id: string, input: Record<string, unknown>): Webhook {
  const existing = db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = ? AND app_id = ?', id, appId);
  if (!existing) throw new HttpError(404, 'webhook_not_found');
  const merged = { url: input.url ?? existing.url, events: input.events ?? parseJson(existing.events, ['*']) };
  const { url, events } = validateWebhookInput(merged);
  const active = input.active === undefined ? existing.active === 1 : input.active === true;
  db.run('UPDATE webhooks SET url = ?, events = ?, active = ? WHERE id = ?', url, JSON.stringify(events), active, id);
  return toWebhook(db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = ?', id)!);
}

export function deleteWebhook(db: Db, appId: string, id: string): void {
  db.run('DELETE FROM webhooks WHERE id = ? AND app_id = ?', id, appId);
}

function enqueueWebhooks(db: Db, appId: string, kind: EventKind, payload: Record<string, unknown>): void {
  const hooks = db.all<WebhookRow>('SELECT * FROM webhooks WHERE app_id = ? AND active = 1', appId).map(toWebhook);
  const body = JSON.stringify(payload);
  for (const hook of hooks) {
    if (!hook.events.includes('*') && !hook.events.includes(kind)) continue;
    db.run('INSERT INTO webhook_deliveries (webhook_id, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)',
      hook.id, body, 'pending', Date.now(), Date.now());
  }
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

const MAX_ATTEMPTS = 8;

/** Delivers due webhooks. Receivers verify X-Twig-Signature = HMAC-SHA256(secret, "<t>.<body>"). */
export async function deliverDueWebhooks(db: Db, fetchImpl: typeof fetch = fetch): Promise<number> {
  const due = db.all<{ id: number; webhook_id: string; payload: string; attempts: number; url: string; secret: string }>(
    `SELECT d.id, d.webhook_id, d.payload, d.attempts, w.url, w.secret FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at LIMIT 25`,
    Date.now(),
  );
  await Promise.all(due.map(async (delivery) => {
    const timestamp = Math.floor(Date.now() / 1000);
    let error: string | null = null;
    try {
      const response = await fetchImpl(delivery.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Twig-Webhooks/1', 'x-twig-signature': signPayload(delivery.secret, timestamp, delivery.payload) },
        body: delivery.payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const attempts = delivery.attempts + 1;
    if (!error) {
      db.run("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_error = NULL WHERE id = ?", attempts, delivery.id);
    } else {
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const delay = Math.min(30_000 * 2 ** (attempts - 1), 6 * 3600 * 1000);
      db.run('UPDATE webhook_deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
        status, attempts, error.slice(0, 500), Date.now() + delay, delivery.id);
    }
  }));
  return due.length;
}

export function recentDeliveries(db: Db, appId: string, limit = 50): Array<Record<string, unknown>> {
  return db.all(
    `SELECT d.id, d.webhook_id, d.status, d.attempts, d.last_error, d.created_at, w.url FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id WHERE w.app_id = ? ORDER BY d.id DESC LIMIT ?`,
    appId, limit,
  );
}
