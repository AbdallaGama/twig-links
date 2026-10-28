import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  /** Path to the SQLite database file, or ":memory:". */
  databasePath: string;
  /** Public base URL of the dashboard and API, e.g. https://links-admin.example.com */
  publicUrl: string;
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  trustProxy: boolean;
  /** Days to keep raw click fingerprints used for deferred deep link matching. */
  clickRetentionDays: number;
  /** Default deferred deep link match window in seconds. */
  defaultMatchWindowSec: number;
  /** Optional bootstrap owner account created on first start. */
  adminEmail: string | null;
  adminPassword: string | null;
  webSdkPath: string;
  dashboardPath: string;
  /** Requests per minute per IP on the public SDK API. */
  sdkRateLimitPerMinute: number;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = resolve(import.meta.dirname, '..');
  const port = int(env.PORT, 8080);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    databasePath: env.DATABASE_PATH ?? resolve(root, 'data', 'twig.db'),
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    clickRetentionDays: int(env.CLICK_RETENTION_DAYS, 30),
    defaultMatchWindowSec: int(env.MATCH_WINDOW_SECONDS, 7200),
    adminEmail: env.ADMIN_EMAIL ?? null,
    adminPassword: env.ADMIN_PASSWORD ?? null,
    webSdkPath: env.WEB_SDK_PATH ?? resolve(root, '..', 'sdk', 'web', 'twig.js'),
    dashboardPath: env.DASHBOARD_PATH ?? resolve(root, 'public'),
    sdkRateLimitPerMinute: int(env.SDK_RATE_LIMIT_PER_MINUTE, 240),
  };
}
