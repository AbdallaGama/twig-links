import type { Db } from './db.ts';

export interface Range {
  from: number;
  to: number;
}

export function parseRange(query: URLSearchParams, defaultDays = 30): Range {
  const to = Number(query.get('to')) || Date.now();
  const days = Math.min(Math.max(Number(query.get('days')) || defaultDays, 1), 366);
  const from = Number(query.get('from')) || to - days * 86400 * 1000;
  return { from, to };
}

const KINDS = ['click', 'install', 'reinstall', 'open', 'web_open', 'event'] as const;

export async function summary(db: Db, appId: string, range: Range): Promise<Record<string, number>> {
  const rows = await db.all<{ kind: string; n: number; revenue: number | null }>(
    'SELECT kind, COUNT(*) AS n, SUM(revenue) AS revenue FROM events WHERE app_id = ? AND created_at BETWEEN ? AND ? GROUP BY kind',
    appId, range.from, range.to,
  );
  const out: Record<string, number> = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  let revenue = 0;
  for (const row of rows) {
    out[row.kind] = row.n;
    revenue += row.revenue ?? 0;
  }
  out.revenue = Math.round(revenue * 100) / 100;
  out.links = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM links WHERE app_id = ?', appId))?.n ?? 0;
  out.attributed_installs = (await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE app_id = ? AND kind IN ('install','reinstall') AND link_id IS NOT NULL AND created_at BETWEEN ? AND ?",
    appId, range.from, range.to,
  ))?.n ?? 0;
  return out;
}

/** Daily counts per kind; days are UTC dates (YYYY-MM-DD). */
export async function timeseries(db: Db, appId: string, range: Range, linkId: number | null = null): Promise<Array<Record<string, string | number>>> {
  const rows = await db.all<{ day: string; kind: string; n: number }>(
    `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, kind, COUNT(*) AS n
     FROM events WHERE app_id = ? AND created_at BETWEEN ? AND ? AND (? IS NULL OR link_id = ?)
     GROUP BY day, kind ORDER BY day`,
    appId, range.from, range.to, linkId, linkId,
  );
  const days = new Map<string, Record<string, string | number>>();
  for (let t = range.from; t <= range.to; t += 86400 * 1000) {
    const day = new Date(t).toISOString().slice(0, 10);
    days.set(day, { day, ...Object.fromEntries(KINDS.map((kind) => [kind, 0])) });
  }
  const last = new Date(range.to).toISOString().slice(0, 10);
  if (!days.has(last)) days.set(last, { day: last, ...Object.fromEntries(KINDS.map((kind) => [kind, 0])) });
  for (const row of rows) {
    const entry = days.get(row.day) ?? { day: row.day };
    entry[row.kind] = row.n;
    days.set(row.day, entry);
  }
  return [...days.values()];
}

const BREAKDOWN_COLUMNS = new Set(['channel', 'feature', 'campaign', 'platform', 'name']);

export async function breakdown(db: Db, appId: string, range: Range, column: string, kind: string | null): Promise<Array<{ value: string | null; count: number; revenue: number }>> {
  if (!BREAKDOWN_COLUMNS.has(column)) column = 'channel';
  return await db.all(
    `SELECT ${column} AS value, COUNT(*) AS count, COALESCE(SUM(revenue), 0) AS revenue FROM events
     WHERE app_id = ? AND created_at BETWEEN ? AND ? AND (? IS NULL OR kind = ?)
     GROUP BY ${column} ORDER BY count DESC LIMIT 50`,
    appId, range.from, range.to, kind, kind,
  );
}

export async function topLinks(db: Db, appId: string, range: Range, limit = 20): Promise<Array<Record<string, unknown>>> {
  return await db.all(
    `SELECT l.id, l.code, l.channel, l.campaign, l.feature,
       SUM(CASE WHEN e.kind = 'click' THEN 1 ELSE 0 END) AS clicks,
       SUM(CASE WHEN e.kind IN ('install', 'reinstall') THEN 1 ELSE 0 END) AS installs,
       SUM(CASE WHEN e.kind = 'open' THEN 1 ELSE 0 END) AS opens,
       SUM(CASE WHEN e.kind = 'event' THEN 1 ELSE 0 END) AS events,
       COALESCE(SUM(e.revenue), 0) AS revenue
     FROM events e JOIN links l ON l.id = e.link_id
     WHERE e.app_id = ? AND e.created_at BETWEEN ? AND ?
     GROUP BY l.id ORDER BY clicks DESC, installs DESC LIMIT ?`,
    appId, range.from, range.to, Math.min(Math.max(limit, 1), 200),
  );
}

/** Per-link funnel plus how clicks were routed (store, intent, interstitial, web, ...). */
export async function linkStats(db: Db, appId: string, linkId: number, range: Range): Promise<Record<string, unknown>> {
  const counts = await db.all<{ kind: string; n: number; revenue: number | null }>(
    'SELECT kind, COUNT(*) AS n, SUM(revenue) AS revenue FROM events WHERE app_id = ? AND link_id = ? AND created_at BETWEEN ? AND ? GROUP BY kind',
    appId, linkId, range.from, range.to,
  );
  const routes = await db.all<{ route: string; os: string | null; n: number }>(
    'SELECT route, os, COUNT(*) AS n FROM clicks WHERE app_id = ? AND link_id = ? AND created_at BETWEEN ? AND ? GROUP BY route, os ORDER BY n DESC',
    appId, linkId, range.from, range.to,
  );
  return {
    counts: Object.fromEntries(counts.map((row) => [row.kind, row.n])),
    revenue: counts.reduce((sum, row) => sum + (row.revenue ?? 0), 0),
    routes,
    timeseries: await timeseries(db, appId, range, linkId),
  };
}

export async function recentEvents(db: Db, appId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
  return await db.all(
    `SELECT id, kind, name, link_id, device_id, identity, channel, campaign, platform, revenue, currency, created_at
     FROM events WHERE app_id = ? ORDER BY id DESC LIMIT ?`,
    appId, Math.min(Math.max(limit, 1), 500),
  );
}
