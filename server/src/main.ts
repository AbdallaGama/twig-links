import { createServer, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { nodeAssets } from './assets-node.ts';
import { bootstrapOwner } from './auth.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { createTwig, runMaintenance } from './server.ts';
import { openSqliteD1 } from './sqlite-d1.ts';

/**
 * Node entry for local development and self-hosting. Production on Cloudflare uses worker.ts;
 * both run the same application with the same SQL schema (D1 here is node:sqlite).
 */
const log = (message: string) => console.log(`[twig] ${new Date().toISOString()} ${message}`);
const port = Number(process.env.PORT ?? 8080);
const config = loadConfig(process.env, `http://localhost:${port}`);
const db = new Db(openSqliteD1(process.env.DATABASE_PATH ?? resolve(import.meta.dirname, '..', 'data', 'twig.db')));
await bootstrapOwner(db, config, log);
const twig = await createTwig(config, db, { log, assets: nodeAssets() });

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  let body: Uint8Array | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(url, { method: req.method, headers, body: body as RequestInit["body"] });
}

const server = createServer(async (req, res) => {
  const forwarded = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
  const response = await twig.handle(await toRequest(req), { ip: forwarded || req.socket.remoteAddress || '' });
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => { headers[key] = key === 'set-cookie' ? response.headers.getSetCookie() : value; });
  res.writeHead(response.status, headers);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
});
server.listen(port, process.env.HOST ?? '0.0.0.0', () => log(`listening on http://localhost:${port} (public URL ${config.publicUrl})`));

let running = false;
let lastPurge = 0;
const timer = setInterval(() => {
  if (running) return;
  running = true;
  const purge = Date.now() - lastPurge > 6 * 3600 * 1000;
  if (purge) lastPurge = Date.now();
  runMaintenance(db, config, log, purge).catch((error: unknown) => log(`maintenance failed: ${String(error)}`)).finally(() => { running = false; });
}, 5000);

function shutdown(signal: string): void {
  log(`${signal} received, shutting down`);
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
