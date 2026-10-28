import { bootstrapOwner } from './auth.ts';
import { loadConfig } from './config.ts';
import type { D1Like } from './db.ts';
import { Db } from './db.ts';
import type { AssetLoader, Twig } from './server.ts';
import { createTwig, runMaintenance } from './server.ts';

/**
 * Cloudflare Worker entry: D1 for storage, static assets for the dashboard and
 * Web SDK, and a cron trigger for webhook delivery and the click purge.
 */
interface WorkerEnv extends Record<string, unknown> {
  DB: D1Like;
  ASSETS: { fetch(request: Request | string): Promise<Response> };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const log = (message: string) => console.log(`[twig] ${message}`);
let twig: Promise<Twig> | null = null;

const CONTENT_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', svg: 'image/svg+xml' };

function assets(env: WorkerEnv): AssetLoader {
  return async (path) => {
    const response = await env.ASSETS.fetch(new Request(`https://assets.local/${path}`));
    if (!response.ok) return null;
    const extension = path.slice(path.lastIndexOf('.') + 1);
    return { body: new Uint8Array(await response.arrayBuffer()), contentType: CONTENT_TYPES[extension] ?? response.headers.get('content-type') ?? 'application/octet-stream' };
  };
}

function app(env: WorkerEnv, origin: string): Promise<Twig> {
  twig ??= (async () => {
    const config = loadConfig(env, origin);
    const db = new Db(env.DB);
    await bootstrapOwner(db, config, log);
    return createTwig(config, db, { log, assets: assets(env) });
  })().catch((error) => {
    twig = null; // retry on the next request
    throw error;
  });
  return twig;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const instance = await app(env, new URL(request.url).origin);
    return instance.handle(request, {
      ip: request.headers.get('cf-connecting-ip') ?? '',
      defer: (task) => ctx.waitUntil(task),
    });
  },

  async scheduled(controller: { cron: string; scheduledTime: number }, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const config = loadConfig(env);
    const db = new Db(env.DB);
    // Every minute: webhooks. Once an hour (minute 0): purge old click fingerprints.
    const purge = new Date(controller.scheduledTime).getUTCMinutes() === 0;
    ctx.waitUntil(runMaintenance(db, config, log, purge));
  },
};
