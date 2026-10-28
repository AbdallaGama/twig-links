/** Runtime-neutral settings: Worker vars (wrangler.toml / secrets) or Node environment variables. */
export interface Config {
  /** Public base URL of the dashboard and API, e.g. https://twig.example.workers.dev */
  publicUrl: string;
  /** Trust X-Forwarded-Host / -Proto (Node behind a proxy). Workers use CF-Connecting-IP. */
  trustProxy: boolean;
  /** Days to keep raw click fingerprints used for deferred deep link matching. */
  clickRetentionDays: number;
  /** Default deferred deep link match window in seconds. */
  defaultMatchWindowSec: number;
  /** Optional bootstrap owner account created on first start. */
  adminEmail: string | null;
  adminPassword: string | null;
  /** Requests per minute per IP on the public SDK API (per isolate on Workers). */
  sdkRateLimitPerMinute: number;
}

export type Env = Record<string, unknown>;

function text(env: Env, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function int(env: Env, key: string, fallback: number): number {
  const parsed = Number.parseInt(text(env, key) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: Env, fallbackPublicUrl = 'http://localhost:8080'): Config {
  return {
    publicUrl: (text(env, 'PUBLIC_URL') ?? fallbackPublicUrl).replace(/\/+$/, ''),
    trustProxy: text(env, 'TRUST_PROXY') === 'true' || text(env, 'TRUST_PROXY') === '1',
    clickRetentionDays: int(env, 'CLICK_RETENTION_DAYS', 30),
    defaultMatchWindowSec: int(env, 'MATCH_WINDOW_SECONDS', 7200),
    adminEmail: text(env, 'ADMIN_EMAIL') ?? null,
    adminPassword: text(env, 'ADMIN_PASSWORD') ?? null,
    sdkRateLimitPerMinute: int(env, 'SDK_RATE_LIMIT_PER_MINUTE', 240),
  };
}
