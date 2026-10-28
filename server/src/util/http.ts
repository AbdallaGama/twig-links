/**
 * Minimal router and helpers on the standard Fetch API (Request/Response), shared by the
 * Cloudflare Worker entry (worker.ts) and the Node entry (main.ts).
 */

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
  req: Request;
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
  /** Set by the send helpers below; returned by the dispatcher. */
  response: Response | null;
  /** Lets work continue after the response (Workers waitUntil; awaited on Node). */
  defer(task: Promise<unknown>): void;
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
        if (part.startsWith(':')) {
          try { params[part.slice(1)] = decodeURIComponent(segment); } catch { ok = false; break; }
        } else if (part !== segment) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

export function createCtx(req: Request, ip: string, trustProxy: boolean, defer: (task: Promise<unknown>) => void): Ctx {
  const url = new URL(req.url);
  if (trustProxy) {
    const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    if (forwardedHost) url.host = forwardedHost;
    if (forwardedProto === 'https' || forwardedProto === 'http') url.protocol = `${forwardedProto}:`;
  }
  let cached: Promise<unknown> | null = null;
  return {
    req,
    method: req.method,
    url,
    host: url.hostname.toLowerCase(),
    path: url.pathname,
    query: url.searchParams,
    ip: ip.replace(/^::ffff:/, ''),
    cookies: parseCookies(req.headers.get('cookie')),
    params: {},
    body<T>() {
      cached ??= readBody(req);
      return cached as Promise<T>;
    },
    response: null,
    defer,
  };
}

export function header(req: Request, name: string): string | undefined {
  return req.headers.get(name) ?? undefined;
}

function parseCookies(text: string | null): Record<string, string> {
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

async function readBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
  if (text.trim() === '') return {};
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

type Body = ConstructorParameters<typeof Response>[0];

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' };

function respond(ctx: Ctx, status: number, body: Body, headers: Record<string, string>): void {
  ctx.response = new Response(ctx.method === 'HEAD' ? null : body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  respond(ctx, status, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
}

export function sendHtml(ctx: Ctx, status: number, html: string, headers: Record<string, string> = {}): void {
  respond(ctx, status, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
}

export function sendBytes(ctx: Ctx, status: number, body: string | Uint8Array, contentType: string, headers: Record<string, string> = {}): void {
  respond(ctx, status, body as Body, { 'content-type': contentType, ...headers });
}

export function redirect(ctx: Ctx, location: string, status = 307, headers: Record<string, string> = {}): void {
  respond(ctx, status, null, { location, 'cache-control': 'no-store', ...headers });
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
