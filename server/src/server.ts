import type { ApiDeps } from './api.ts';
import { registerAdminRoutes, registerSdkRoutes, serveLinkQr } from './api.ts';
import { appForHost } from './apps.ts';
import { appleAppSiteAssociation, assetLinks } from './association.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { deliverDueWebhooks } from './events.ts';
import { handleLinkClick } from './links-handler.ts';
import { purgeOldClicks } from './matching.ts';
import type { Ctx } from './util/http.ts';
import { createCtx, HttpError, redirect, Router, sendBytes, sendJson } from './util/http.ts';

const SDK_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const DASHBOARD_HEADERS = {
  'cache-control': 'no-cache',
  'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

/** Per-isolate token bucket. On Workers each isolate counts separately (best-effort limit). */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, updated: now };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + ((now - bucket.updated) / 60_000) * this.perMinute);
    bucket.updated = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 50_000) {
      for (const [k, b] of this.buckets) if (now - b.updated > 120_000) this.buckets.delete(k);
    }
    return allowed;
  }
}

/**
 * Loads bundled static files: the dashboard (`dashboard/*`) and the Web SDK (`sdk/twig.js`).
 * Returns null when the file does not exist.
 */
export type AssetLoader = (path: string) => Promise<{ body: string | Uint8Array; contentType: string } | null>;

export interface RequestEnv {
  ip: string;
  /** Workers: ctx.waitUntil. Omitted on Node, where deferred work is awaited before responding. */
  defer?: (task: Promise<unknown>) => void;
}

export interface Twig {
  handle(request: Request, env: RequestEnv): Promise<Response>;
}

/** Webhook delivery plus the click-fingerprint purge (Workers cron trigger / Node timer). */
export async function runMaintenance(db: Db, config: Config, log: (message: string) => void, purge: boolean): Promise<{ delivered: number; purged: number }> {
  const delivered = await deliverDueWebhooks(db);
  const purged = purge ? await purgeOldClicks(db, config.clickRetentionDays) : 0;
  if (purged > 0) log(`purged ${purged} click fingerprints older than ${config.clickRetentionDays} days`);
  return { delivered, purged };
}

export async function createTwig(config: Config, db: Db, options: { log?: (message: string) => void; assets: AssetLoader }): Promise<Twig> {
  const log = options.log ?? console.log;
  const deps: ApiDeps = { db, config, secret: await db.serverSecret() };
  const router = new Router();
  registerSdkRoutes(router, deps);
  registerAdminRoutes(router, deps);
  const sdkLimiter = new RateLimiter(config.sdkRateLimitPerMinute);
  const authLimiter = new RateLimiter(20);

  router.get('/healthz', (ctx) => sendJson(ctx, 200, { ok: true }));

  const serveAsset = async (ctx: Ctx, path: string, headers: Record<string, string>) => {
    if (path.split('/').some((part) => part === '..' || part === '')) throw new HttpError(404, 'not_found');
    const asset = await options.assets(path);
    if (!asset) throw new HttpError(404, 'not_found');
    sendBytes(ctx, 200, asset.body, asset.contentType, headers);
  };
  router.get('/sdk/twig.js', (ctx) => serveAsset(ctx, 'sdk/twig.js', { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }));
  router.get('/dashboard', (ctx) => serveAsset(ctx, 'dashboard/index.html', DASHBOARD_HEADERS));
  router.get('/dashboard/:file', (ctx) => serveAsset(ctx, `dashboard/${ctx.params.file!}`, DASHBOARD_HEADERS));

  async function dispatch(ctx: Ctx): Promise<void> {
    const { path } = ctx;

    if (path.startsWith('/v1/')) {
      if (ctx.method === 'OPTIONS') {
        ctx.response = new Response(null, { status: 204, headers: SDK_CORS });
        return;
      }
      if (!sdkLimiter.allow(ctx.ip)) throw new HttpError(429, 'rate_limited');
    }
    if (ctx.method === 'POST' && (path === '/api/auth/login' || path === '/api/auth/setup') && !authLimiter.allow(ctx.ip)) {
      throw new HttpError(429, 'rate_limited');
    }

    if (path === '/.well-known/apple-app-site-association' || path === '/apple-app-site-association') {
      const owner = await appForHost(db, ctx.host);
      if (!owner) throw new HttpError(404, 'unknown_domain');
      sendJson(ctx, 200, appleAppSiteAssociation(owner.app), { 'cache-control': 'public, max-age=3600' });
      return;
    }
    if (path === '/.well-known/assetlinks.json') {
      const owner = await appForHost(db, ctx.host);
      if (!owner) throw new HttpError(404, 'unknown_domain');
      sendJson(ctx, 200, assetLinks(owner.app), { 'cache-control': 'public, max-age=3600' });
      return;
    }

    const route = router.match(ctx.method, path);
    if (route) {
      ctx.params = route.params;
      await route.handler(ctx);
      return;
    }

    const owner = await appForHost(db, ctx.host);
    if (owner && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
      const qr = /^\/qr\/([^/]+)$/.exec(path);
      if (qr) {
        await serveLinkQr(deps, ctx, owner.app, decodeURIComponent(qr[1]!));
        return;
      }
      if (path === '/robots.txt') {
        sendBytes(ctx, 200, 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8');
        return;
      }
      if (path === '/favicon.ico') throw new HttpError(404, 'not_found');
      await handleLinkClick(deps, ctx, owner.app);
      return;
    }

    if (path === '/' && ctx.method === 'GET') {
      redirect(ctx, '/dashboard', 302);
      return;
    }
    throw new HttpError(404, 'not_found');
  }

  return {
    async handle(request, env) {
      const pending: Array<Promise<unknown>> = [];
      const defer = env.defer ?? ((task: Promise<unknown>) => { pending.push(task); });
      const ctx = createCtx(request, env.ip, config.trustProxy, (task) => defer(task.catch((error) => log(`deferred task failed: ${String(error)}`))));
      try {
        await dispatch(ctx);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(ctx, error.status, { error: error.code, message: error.message });
        } else {
          log(`Unhandled error on ${ctx.method} ${ctx.path}: ${error instanceof Error ? error.stack : String(error)}`);
          sendJson(ctx, 500, { error: 'internal_error' });
        }
      }
      await Promise.all(pending);
      const response = ctx.response ?? new Response(null, { status: 404 });
      if (ctx.path.startsWith('/v1/')) for (const [key, value] of Object.entries(SDK_CORS)) response.headers.set(key, value);
      return response;
    },
  };
}
