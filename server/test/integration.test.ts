import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { deliverDueWebhooks } from '../src/events.ts';
import { http, startServer, UA, type Harness } from './helpers.ts';

let h: Harness;
let cookie = '';
let appId = '';
let publicKey = '';
let secretKey = '';
const LINK_HOST = 'links.shop.test';
const ALT_HOST = 'open.shop.test';

const dash = (path: string, method = 'GET', body?: unknown) =>
  http(h.port, { method, path, body, headers: { cookie, 'x-twig-client': 'dashboard' } });

const sdk = (path: string, body: Record<string, unknown>, ip = '198.51.100.20') =>
  http(h.port, { method: 'POST', path, body: { key: publicKey, ...body }, headers: { 'x-forwarded-for': ip } });

const click = (path: string, ua: string, extraHeaders: Record<string, string> = {}, host = LINK_HOST) =>
  http(h.port, { path, host, headers: { 'user-agent': ua, ...extraHeaders } });

before(async () => {
  h = await startServer();
});

after(async () => {
  await h.close();
});

describe('Twig end to end', () => {
  it('requires the one-time setup token before creating the owner', async () => {
    const state = await http(h.port, { path: '/api/auth/state' });
    assert.equal(state.json().setup_required, true);
    const bad = await http(h.port, { method: 'POST', path: '/api/auth/setup', body: { setup_token: 'nope', email: 'owner@shop.test', password: 'correct horse battery' } });
    assert.equal(bad.status, 403);
  });

  it('creates the owner and signs in', async () => {
    await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('setup_token', 'tok_test')");
    const token = 'tok_test';
    const res = await http(h.port, { method: 'POST', path: '/api/auth/setup', body: { setup_token: token, email: 'owner@shop.test', name: 'Owner', password: 'correct horse battery' } });
    assert.equal(res.status, 200, res.body);
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
    assert.match(cookie, /^twig_session=/);
    const me = await dash('/api/auth/state');
    assert.equal(me.json().user.role, 'owner');
  });

  it('rejects state-changing dashboard calls without the client header (CSRF guard)', async () => {
    const res = await http(h.port, { method: 'POST', path: '/api/apps', body: { name: 'x' }, headers: { cookie } });
    assert.equal(res.status, 403);
  });

  it('creates an app with domains', async () => {
    const res = await dash('/api/apps', 'POST', {
      name: 'Shop',
      config: {
        ios: { teamId: 'ABCDE12345', bundleIds: ['com.shop.app'], appStoreId: '123456789', uriScheme: 'shop' },
        android: { packageName: 'com.shop.app', uriScheme: 'shop', sha256Fingerprints: ['14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5'] },
        desktopUrl: 'https://shop.test/',
        og: { title: 'Shop', description: 'Best deals' },
      },
      domains: [{ host: LINK_HOST, kind: 'primary' }, { host: ALT_HOST, kind: 'alternate' }],
    });
    assert.equal(res.status, 201, res.body);
    const json = res.json();
    appId = json.app.id;
    publicKey = json.app.public_key;
    secretKey = json.secret_key;
    assert.match(publicKey, /^tw_live_/);
    assert.match(secretKey, /^tw_secret_/);
    assert.equal(json.app.domains.length, 2);
  });

  it('serves association files per domain', async () => {
    const aasa = await http(h.port, { path: '/.well-known/apple-app-site-association', host: LINK_HOST });
    assert.equal(aasa.status, 200);
    assert.match(String(aasa.headers['content-type']), /application\/json/);
    const detail = aasa.json().applinks.details[0];
    assert.deepEqual(detail.appIDs, ['ABCDE12345.com.shop.app']);
    assert.ok(detail.components.some((c: any) => c.exclude && c['?']?.$web_only === 'true'));
    const alt = await http(h.port, { path: '/apple-app-site-association', host: ALT_HOST });
    assert.equal(alt.status, 200);
    const assetlinks = await http(h.port, { path: '/.well-known/assetlinks.json', host: LINK_HOST });
    assert.equal(assetlinks.json()[0].target.package_name, 'com.shop.app');
    const unknown = await http(h.port, { path: '/.well-known/assetlinks.json', host: 'nope.test' });
    assert.equal(unknown.status, 404);
  });

  let shortCode = '';
  it('creates short links from the SDK (deduplicated) and the server API (secret key)', async () => {
    const body = { data: { $deeplink_path: 'product/42', product_id: '42', $og_title: 'Red Shoes' }, channel: 'whatsapp', campaign: 'summer' };
    const first = await sdk('/v1/url', body);
    const second = await sdk('/v1/url', body);
    assert.equal(first.status, 200, first.body);
    assert.equal(first.json().url, second.json().url);
    assert.ok(first.json().url.startsWith(`https://${LINK_HOST}/`));
    shortCode = first.json().code;

    const api = await http(h.port, { method: 'POST', path: `/api/apps/${appId}/links`, headers: { authorization: `Bearer ${secretKey}` }, body: { alias: 'summer-sale', data: { promo: 'SUMMER' }, channel: 'email' } });
    assert.equal(api.status, 201, api.body);
    assert.equal(api.json().link.url, `https://${LINK_HOST}/summer-sale`);
    const conflict = await http(h.port, { method: 'POST', path: `/api/apps/${appId}/links`, headers: { authorization: `Bearer ${secretKey}` }, body: { alias: 'summer-sale', data: { promo: 'OTHER' } } });
    assert.equal(conflict.status, 409);
    const wrongApp = await http(h.port, { method: 'GET', path: `/api/apps/app_other/links`, headers: { authorization: `Bearer ${secretKey}` } });
    assert.equal(wrongApp.status, 403);
  });

  it('shows crawlers an Open Graph preview without recording a click', async () => {
    const res = await click(`/${shortCode}`, UA.facebookBot);
    assert.equal(res.status, 200);
    assert.match(res.body, /<meta property="og:title" content="Red Shoes">/);
    assert.match(res.body, /<meta property="al:ios:app_store_id" content="123456789">/);
    const clicks = (await h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM clicks'))!.n;
    assert.equal(clicks, 0);
  });

  it('routes Android Chrome to an intent and matches the install through the Play referrer', async () => {
    const res = await click(`/${shortCode}`, UA.androidChrome);
    assert.equal(res.status, 307);
    const location = String(res.headers.location);
    assert.ok(location.startsWith('intent://product/42?link_click_id='));
    const clickId = /link_click_id=(\d+)/.exec(location)![1]!;
    assert.match(String(res.headers['set-cookie']), /^_tw=/);

    const open = await sdk('/v1/open', {
      is_first_launch: true, hardware_id: 'android-hw-1', os: 'Android', os_version: '15', model: 'Pixel 9',
      install_referrer: `link_click_id=${clickId}&utm_source=whatsapp`,
    }, '203.0.113.9');
    assert.equal(open.status, 200, open.body);
    const data = open.json().data;
    assert.equal(data['+clicked_link'], true);
    assert.equal(data['+match_guaranteed'], true);
    assert.equal(data['+match_type'], 'install_referrer');
    assert.equal(data['+is_first_session'], true);
    assert.equal(data.product_id, '42');
    assert.equal(data['~channel'], 'whatsapp');
    assert.equal(data['~campaign'], 'summer');
  });

  let iosDevice = '';
  it('routes iOS Safari to the interstitial and matches the install by fingerprint', async () => {
    const res = await click(`/${shortCode}`, UA.iosSafari, { 'x-forwarded-for': '198.51.100.77', 'accept-language': 'en-US,en;q=0.9' });
    assert.equal(res.status, 200);
    assert.match(res.body, /Open in the app/);
    assert.match(res.body, new RegExp(`https://${ALT_HOST.replace(/\./g, '\\.')}/${shortCode}\\?__twig_flow=store&amp;_twig_match_id=\\d+`));
    assert.match(String(res.headers['content-security-policy']), /script-src 'nonce-/);

    // Same network as the click (the harness passes x-forwarded-for as the client IP).
    const open = await sdk('/v1/open', { is_first_launch: true, hardware_id: 'ios-idfv-1', os: 'iOS', os_version: '18.5.1', model: 'iPhone15,2', locale: 'en_US' }, '198.51.100.77');
    const data = open.json().data;
    assert.equal(data['+clicked_link'], true);
    assert.equal(data['+match_type'], 'fingerprint');
    assert.equal(data['+match_guaranteed'], false);
    assert.equal(data.product_id, '42');
    iosDevice = open.json().device_token;

    const again = await sdk('/v1/open', { device_token: iosDevice, os: 'iOS' });
    assert.equal(again.json().data['+clicked_link'], false, 'a click is claimed only once');
  });

  it('follows the store hop on the alternate domain without counting a second click', async () => {
    const before = (await h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM clicks'))!.n;
    const res = await click(`/${shortCode}?__twig_flow=store&_twig_match_id=1730000000000123456`, UA.iosSafari, {}, ALT_HOST);
    assert.equal(res.status, 307);
    assert.equal(res.headers.location, 'https://apps.apple.com/app/id123456789');
    assert.equal((await h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM clicks'))!.n, before);
  });

  it('resolves pasteboard links (NativeLink) deterministically', async () => {
    const res = await click(`/${shortCode}`, UA.iosSafari);
    const copyUrl = /var c="([^"]+)"/.exec(res.body)![1]!;
    const open = await sdk('/v1/open', { is_first_launch: true, hardware_id: 'ios-idfv-2', os: 'iOS', pasteboard_url: `${copyUrl}&_cpts=${Date.now()}` });
    assert.equal(open.json().data['+match_type'], 'pasteboard');
    assert.equal(open.json().data['+match_guaranteed'], true);
  });

  it('resolves Universal Links reported by the SDK, including long links and path links', async () => {
    const ul = await sdk('/v1/open', { device_token: iosDevice, os: 'iOS', link_url: `https://${LINK_HOST}/summer-sale` });
    assert.equal(ul.json().data.promo, 'SUMMER');
    assert.equal(ul.json().data['+match_type'], 'universal_link');

    const long = await sdk('/v1/open', { device_token: iosDevice, os: 'iOS', link_url: `https://${LINK_HOST}/?$deeplink_path=cart&coupon=X1&~channel=sms` });
    assert.equal(long.json().data.coupon, 'X1');
    assert.equal(long.json().data['~channel'], 'sms');

    const other = await sdk('/v1/open', { device_token: iosDevice, os: 'iOS', link_url: 'https://www.shop.test/products/9' });
    assert.equal(other.json().data['+clicked_link'], false);
    assert.equal(other.json().data['+non_twig_link'], 'https://www.shop.test/products/9');
  });

  it('turns unknown multi-segment paths into path links for deferred deep linking', async () => {
    const res = await click('/products/99?color=red', UA.androidChrome);
    assert.equal(res.status, 307);
    assert.ok(String(res.headers.location).startsWith('intent://products/99?link_click_id='));
  });

  it('sends desktop users to the desktop URL with a match id the Web SDK can claim', async () => {
    const res = await click(`/${shortCode}`, UA.macChrome);
    assert.equal(res.status, 307);
    const location = new URL(String(res.headers.location));
    assert.equal(location.origin + location.pathname, 'https://shop.test/');
    const matchId = location.searchParams.get('_twig_match_id');
    const web = await sdk('/v1/web/open', { match_id: matchId, url: location.toString() });
    assert.equal(web.json().data['+match_type'], 'web_match_id');
    assert.match(web.json().device_token, /^wb_/);
  });

  it('attributes in-app events to the last link touch', async () => {
    const event = await sdk('/v1/event', { device_token: iosDevice, name: 'purchase', revenue: 59.9, currency: 'usd', data: { sku: 'A1' } });
    assert.equal(event.status, 200, event.body);
    assert.equal(event.json().attributed, true);
    const row = (await h.db.get<{ name: string; currency: string; revenue: number }>('SELECT name, currency, revenue FROM events WHERE id = ?', event.json().event_id))!;
    assert.deepEqual({ ...row }, { name: 'PURCHASE', currency: 'USD', revenue: 59.9 });
    const unknown = await sdk('/v1/event', { device_token: 'dv_missing', name: 'x' });
    assert.equal(unknown.status, 400);
  });

  it('reports analytics, link stats and CSV exports', async () => {
    const summary = (await dash(`/api/apps/${appId}/analytics/summary?days=7`)).json().summary;
    assert.ok(summary.click >= 4);
    assert.ok(summary.install >= 3);
    assert.equal(summary.revenue, 59.9);
    const stats = (await dash(`/api/apps/${appId}/links/${shortCode}/stats`)).json().stats;
    assert.ok(stats.routes.some((r: any) => r.route === 'redirect:android_intent'));
    assert.ok(stats.routes.some((r: any) => r.route === 'ios_deepview:ios_nativelink'));
    const top = (await dash(`/api/apps/${appId}/analytics/top-links`)).json().links;
    assert.equal(top[0].code, shortCode);
    const csv = await dash(`/api/apps/${appId}/export/events.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.body.split('\n')[0]!, /^id,created_at,kind,name/);
    const series = (await dash(`/api/apps/${appId}/analytics/timeseries?days=3`)).json().series;
    assert.ok(series.length >= 3);
  });

  it('serves QR codes for links', async () => {
    const svg = await http(h.port, { path: `/qr/${shortCode}.svg`, host: LINK_HOST });
    assert.equal(svg.status, 200);
    assert.match(svg.body, /^<svg/);
    const png = await http(h.port, { path: `/v1/qr?format=png&url=${encodeURIComponent(`https://${LINK_HOST}/${shortCode}`)}` });
    assert.equal(png.headers['content-type'], 'image/png');
    const foreign = await http(h.port, { path: `/v1/qr?url=${encodeURIComponent('https://evil.test/x')}` });
    assert.equal(foreign.status, 400);
  });

  it('delivers signed webhooks with retries', async () => {
    const received: Array<{ body: string; signature: string }> = [];
    let failFirst = true;
    const receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (failFirst) { failFirst = false; res.writeHead(500); res.end(); return; }
        received.push({ body: Buffer.concat(chunks).toString(), signature: String(req.headers['x-twig-signature']) });
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const port = (receiver.address() as AddressInfo).port;
    const created = await dash(`/api/apps/${appId}/webhooks`, 'POST', { url: `http://127.0.0.1:${port}/hook`, events: ['click'] });
    assert.equal(created.status, 201, created.body);
    const secret = created.json().webhook.secret;

    await click('/summer-sale', UA.windowsEdge);
    await deliverDueWebhooks(h.db);
    assert.equal(received.length, 0, 'first attempt failed');
    await h.db.run("UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE status = 'pending'");
    await deliverDueWebhooks(h.db);
    receiver.close();

    assert.equal(received.length, 1);
    const payload = JSON.parse(received[0]!.body);
    assert.equal(payload.event, 'click');
    assert.equal(payload.channel, 'email');
    const [t, v1] = received[0]!.signature.split(',').map((part) => part.split('=')[1]!);
    assert.equal(v1, createHmac('sha256', secret).update(`${t}.${received[0]!.body}`).digest('hex'));
  });

  it('manages team members with roles', async () => {
    const created = await dash('/api/users', 'POST', { email: 'dev@shop.test', name: 'Dev', password: 'another long password', role: 'member' });
    assert.equal(created.status, 201, created.body);
    const login = await http(h.port, { method: 'POST', path: '/api/auth/login', body: { email: 'dev@shop.test', password: 'another long password' } });
    const memberCookie = String(login.headers['set-cookie']).split(';')[0]!;
    const forbidden = await http(h.port, { method: 'POST', path: '/api/apps', body: { name: 'X' }, headers: { cookie: memberCookie, 'x-twig-client': 'dashboard' } });
    assert.equal(forbidden.status, 403);
    const wrong = await http(h.port, { method: 'POST', path: '/api/auth/login', body: { email: 'dev@shop.test', password: 'wrong password!!' } });
    assert.equal(wrong.status, 401);
  });

  it('rejects unknown keys and domains taken by another app', async () => {
    const res = await http(h.port, { method: 'POST', path: '/v1/open', body: { key: 'tw_live_nope' } });
    assert.equal(res.status, 401);
    const other = await dash('/api/apps', 'POST', { name: 'Other', domains: [{ host: LINK_HOST }] });
    assert.equal(other.status, 409);
    const preflight = await http(h.port, { method: 'OPTIONS', path: '/v1/open' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
  });
});
