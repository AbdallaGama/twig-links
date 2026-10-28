import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  /** Lowercased host without port. */
  host: string;
  path: string;
  query: URLSearchParams;
  ip: string;
  cookies: Record<string, string>;
  params: Record<string, string>;
  body<T = Record<string, unknown>>(): Promise<T>;
}

export type Handler = (ctx: Ctx) => unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this { return this.on('GET', pattern, handler); }
  post(pattern: string, handler: Handler): this { return this.on('POST', pattern, handler); }
  patch(pattern: string, handler: Handler): this { return this.on('PATCH', pattern, handler); }
  delete(pattern: string, handler: Handler): this { return this.on('DELETE', pattern, handler); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const segments = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      if (route.parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const part = route.parts[i]!;
        const segment = segments[i]!;
        if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segment);
        else if (part !== segment) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

export function createCtx(req: IncomingMessage, res: ServerResponse, trustProxy: boolean): Ctx {
  const forwardedHost = trustProxy ? header(req, 'x-forwarded-host') : undefined;
  const rawHost = (forwardedHost ?? req.headers.host ?? 'localhost').split(',')[0]!.trim();
  const proto = trustProxy ? (header(req, 'x-forwarded-proto') ?? 'http').split(',')[0]!.trim() : 'http';
  const url = new URL(req.url ?? '/', `${proto}://${rawHost}`);
  const forwardedFor = trustProxy ? header(req, 'x-forwarded-for') : undefined;
  const ip = (forwardedFor?.split(',')[0]?.trim() || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let cached: Promise<unknown> | null = null;
  return {
    req,
    res,
    method: req.method ?? 'GET',
    url,
    host: url.hostname.toLowerCase(),
    path: url.pathname,
    query: url.searchParams,
    ip,
    cookies: parseCookies(req.headers.cookie),
    params: {},
    body<T>() {
      cached ??= readBody(req);
      return cached as Promise<T>;
    },
  };
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseCookies(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const pair of text.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    try {
      out[key] = decodeURIComponent(pair.slice(index + 1).trim());
    } catch {
      out[key] = pair.slice(index + 1).trim();
    }
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' };

export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  ctx.res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  ctx.res.end(ctx.method === 'HEAD' ? undefined : payload);
}

export function sendHtml(ctx: Ctx, status: number, html: string, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  ctx.res.end(ctx.method === 'HEAD' ? undefined : html);
}

export function sendBytes(ctx: Ctx, status: number, body: string | Buffer, contentType: string, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, { ...BASE_HEADERS, 'content-type': contentType, ...headers });
  ctx.res.end(ctx.method === 'HEAD' ? undefined : body);
}

export function redirect(ctx: Ctx, location: string, status = 307, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, { ...BASE_HEADERS, location, 'cache-control': 'no-store', ...headers });
  ctx.res.end();
}

export function setCookieHeader(name: string, value: string, options: { maxAgeSec: number; secure: boolean; httpOnly?: boolean; sameSite?: 'Lax' | 'None' | 'Strict' }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${options.maxAgeSec}`, 'Path=/'];
  if (options.secure) parts.push('Secure');
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function str(value: unknown, max = 4096): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

export function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function obj(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
