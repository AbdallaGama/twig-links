import { request, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { App } from '../src/apps.ts';
import { normalizeConfig } from '../src/apps.ts';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { createTwig } from '../src/server.ts';

export const UA = {
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iosInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0 (iPhone15,2; iOS 18_5; en_US)',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidChromeReduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidFacebook: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  facebookBot: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  iMessage: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
  whatsapp: 'WhatsApp/2.23.20.0',
};

export function testApp(overrides: Record<string, unknown> = {}): App {
  return {
    id: 'app_test',
    name: 'Shop',
    publicKey: 'tw_live_test',
    secretHint: 'abcd',
    createdAt: 0,
    domains: [{ host: 'links.shop.test', kind: 'primary' }, { host: 'open.shop.test', kind: 'alternate' }],
    config: normalizeConfig({
      ios: { teamId: 'ABCDE12345', bundleIds: ['com.shop.app'], appStoreId: '123456789', uriScheme: 'shop' },
      android: { packageName: 'com.shop.app', uriScheme: 'shop', sha256Fingerprints: ['AA'.repeat(32)] },
      desktopUrl: 'https://shop.test/',
      fallbackUrl: 'https://shop.test/m',
      og: { title: 'Shop', description: 'Best shop', imageUrl: 'https://shop.test/icon.png' },
      ...overrides,
    }),
  };
}

export interface Harness {
  baseUrl: string;
  port: number;
  db: Db;
  close(): Promise<void>;
}

export async function startServer(): Promise<Harness> {
  const config = { ...loadConfig({}), databasePath: ':memory:', publicUrl: 'http://admin.test', sdkRateLimitPerMinute: 100_000 };
  const db = new Db(':memory:');
  const twig = createTwig(config, db, () => {});
  const server: Server = createServer((req, res) => { void twig.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    db,
    close: () => new Promise<void>((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = any>(): T;
}

export function http(port: number, options: { method?: string; path: string; host?: string; headers?: Record<string, string>; body?: unknown }): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const req = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path,
      headers: {
        host: options.host ?? 'admin.test',
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload).toString() } : {}),
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
