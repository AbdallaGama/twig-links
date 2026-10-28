import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ApiDeps } from './api.ts';
import { registerAdminRoutes, registerSdkRoutes, serveLinkQr } from './api.ts';
import { appForHost } from './apps.ts';
import { appleAppSiteAssociation, assetLinks } from './association.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { handleLinkClick } from './links-handler.ts';
import type { Ctx } from './util/http.ts';
import { createCtx, HttpError, redirect, Router, sendBytes, sendJson } from './util/http.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const SDK_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

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
    if (bucket.tokens < 1) { this.buckets.set(key, bucket); return false; }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 50_000) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (now - bucket.updated > 120_000) this.buckets.delete(key);
  }
}

export interface Twig {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createTwig(config: Config, db: Db, log: (message: string) => void = console.log): Twig {
  const deps: ApiDeps = { db, config, secret: db.serverSecret() };
  const router = new Router();
  registerSdkRoutes(router, deps);
  registerAdminRoutes(router, deps);
  const sdkLimiter = new RateLimiter(config.sdkRateLimitPerMinute);
  const authLimiter = new RateLimiter(20);
  const dashboardRoot = resolve(config.dashboardPath);

  router.get('/healthz', (ctx) => sendJson(ctx, 200, { ok: true }));

  // Caddy on-demand TLS asks here before issuing a certificate, so only registered link
  // domains (and the dashboard host) can obtain certificates through this server.
  router.get('/caddy/ask', (ctx) => {
    const domain = (ctx.query.get('domain') ?? '').toLowerCase();
    const allowed = domain !== '' && (appForHost(db, domain) !== null || domain === new URL(config.publicUrl).hostname);
    sendJson(ctx, allowed ? 200 : 404, { allowed });
  });

  router.get('/sdk/twig.js', (ctx) => {
    let body: Buffer;
    try {
      body = readFileSync(config.webSdkPath);
    } catch {
      throw new HttpError(404, 'web_sdk_missing');
    }
    sendBytes(ctx, 200, body, CONTENT_TYPES['.js']!, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
  });

  const serveDashboard = (ctx: Ctx, file: string) => {
    const target = normalize(join(dashboardRoot, file));
    if (target !== dashboardRoot && !target.startsWith(dashboardRoot + sep)) throw new HttpError(404, 'not_found');
    try {
      if (!statSync(target).isFile()) throw new Error('not a file');
    } catch {
      throw new HttpError(404, 'not_found');
    }
    sendBytes(ctx, 200, readFileSync(target), CONTENT_TYPES[extname(target)] ?? 'application/octet-stream', {
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
  };
  router.get('/dashboard', (ctx) => serveDashboard(ctx, 'index.html'));
  router.get('/dashboard/:file', (ctx) => serveDashboard(ctx, ctx.params.file!));

  async function dispatch(ctx: Ctx): Promise<void> {
    const { path } = ctx;

    if (path.startsWith('/v1/')) {
      if (ctx.method === 'OPTIONS') {
        ctx.res.writeHead(204, SDK_CORS);
        ctx.res.end();
        return;
      }
      for (const [key, value] of Object.entries(SDK_CORS)) ctx.res.setHeader(key, value);
      if (!sdkLimiter.allow(ctx.ip)) throw new HttpError(429, 'rate_limited');
    }
    if (ctx.method === 'POST' && (path === '/api/auth/login' || path === '/api/auth/setup') && !authLimiter.allow(ctx.ip)) {
      throw new HttpError(429, 'rate_limited');
    }

    if (path === '/.well-known/apple-app-site-association' || path === '/apple-app-site-association') {
      const owner = appForHost(db, ctx.host);
      if (!owner) throw new HttpError(404, 'unknown_domain');
      sendJson(ctx, 200, appleAppSiteAssociation(owner.app), { 'cache-control': 'public, max-age=3600' });
      return;
    }
    if (path === '/.well-known/assetlinks.json') {
      const owner = appForHost(db, ctx.host);
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

    const owner = appForHost(db, ctx.host);
    if (owner && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
      const qr = /^\/qr\/([^/]+)$/.exec(path);
      if (qr) {
        serveLinkQr(deps, ctx, owner.app, decodeURIComponent(qr[1]!));
        return;
      }
      if (path === '/robots.txt') {
        sendBytes(ctx, 200, 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8');
        return;
      }
      if (path === '/favicon.ico') throw new HttpError(404, 'not_found');
      handleLinkClick(deps, ctx, owner.app);
      return;
    }

    if (path === '/' && ctx.method === 'GET') {
      redirect(ctx, '/dashboard', 302);
      return;
    }
    throw new HttpError(404, 'not_found');
  }

  return {
    async handle(req, res) {
      const ctx = createCtx(req, res, config.trustProxy);
      try {
        await dispatch(ctx);
      } catch (error) {
        if (res.headersSent) { res.end(); return; }
        if (error instanceof HttpError) {
          sendJson(ctx, error.status, { error: error.code, message: error.message });
        } else {
          log(`Unhandled error on ${ctx.method} ${ctx.path}: ${error instanceof Error ? error.stack : String(error)}`);
          sendJson(ctx, 500, { error: 'internal_error' });
        }
      }
    },
  };
}
