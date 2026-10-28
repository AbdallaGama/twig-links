import type { App } from './apps.ts';
import { primaryHost } from './apps.ts';
import type { Db } from './db.ts';
import { logEvent } from './events.ts';
import type { ResolvedLink } from './links.ts';
import { dataFromQuery, publicLinkData, resolvePath } from './links.ts';
import { recordClick, tagsFromData, updateClickRoute } from './matching.ts';
import { androidDeepviewPage, desktopPage, iosDeepviewPage, notFoundPage, ogPage, schemeThenFallbackPage } from './pages.ts';
import type { Page } from './pages.ts';
import { encodeQr, qrToSvg } from './qr.ts';
import { decideRoute, FLOW_PARAM, MATCH_PARAM } from './routing.ts';
import { parseUserAgent } from './ua.ts';
import { randomBase62 } from './util/crypto.ts';
import type { Ctx } from './util/http.ts';
import { header, redirect, sendHtml, setCookieHeader } from './util/http.ts';

const BROWSER_COOKIE = '_tw';
const NON_DATA_KEYS = ['link_click_id', MATCH_PARAM, FLOW_PARAM, '_cpts', 'nl_opt_in', 'nl_opt_out'];

export interface ClickDeps {
  db: Db;
  secret: string;
}

function canonicalLinkUrl(ctx: Ctx, app: App): string {
  const url = new URL(`https://${primaryHost(app) ?? ctx.host}${ctx.path}`);
  for (const [key, value] of ctx.query) if (!NON_DATA_KEYS.includes(key)) url.searchParams.append(key, value);
  return url.toString();
}

/**
 * Paths with several segments that are not short links (e.g. /products/42) are treated as
 * path links: the path becomes $deeplink_path so website-style URLs still deep link after
 * install. A single unknown segment is a dead short link and falls back to app defaults.
 */
async function resolveRequest(deps: ClickDeps, ctx: Ctx, app: App, linkUrl: string): Promise<ResolvedLink | null> {
  const resolved = await resolvePath(deps.db, app, ctx.path, ctx.query, linkUrl);
  if (resolved) return resolved;
  const segments = ctx.path.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const { data, tags } = dataFromQuery(ctx.query);
  return { link: null, data: { ...data, $deeplink_path: segments.join('/'), '$path_link': 'true' }, tags, url: linkUrl };
}

export async function handleLinkClick(deps: ClickDeps, ctx: Ctx, app: App): Promise<void> {
  const userAgent = header(ctx.req, 'user-agent') ?? '';
  const client = parseUserAgent(userAgent, {
    platformVersion: header(ctx.req, 'sec-ch-ua-platform-version'),
    model: header(ctx.req, 'sec-ch-ua-model'),
  });
  const linkUrl = canonicalLinkUrl(ctx, app);
  const resolved = await resolveRequest(deps, ctx, app, linkUrl);
  const data = resolved?.data ?? {};

  if (client.isBot) {
    const page = resolved || ctx.path === '/' ? ogPage(app, data, linkUrl) : notFoundPage();
    sendHtml(ctx, resolved || ctx.path === '/' ? 200 : 404, page.html, page.headers);
    return;
  }

  const secure = ctx.url.protocol === 'https:';
  const headers: Record<string, string> = { 'accept-ch': 'Sec-CH-UA-Platform-Version, Sec-CH-UA-Model' };
  let browserId = ctx.cookies[BROWSER_COOKIE] ?? null;
  if (!browserId || !/^[A-Za-z0-9]{16,40}$/.test(browserId)) {
    browserId = randomBase62(24);
    headers['set-cookie'] = setCookieHeader(BROWSER_COOKIE, browserId, { maxAgeSec: 365 * 86400, secure, httpOnly: true, sameSite: 'Lax' });
  }

  const flow = ctx.query.get(FLOW_PARAM);
  const carriedClick = ctx.query.get(MATCH_PARAM);
  let clickId: string | null = null;
  let isNewClick = false;
  if (flow === 'store' && carriedClick && /^\d{10,30}$/.test(carriedClick)) {
    clickId = carriedClick; // second hop of an interstitial: same click, do not count twice
  } else if (resolved) {
    clickId = await recordClick(deps.db, {
      app,
      resolved,
      client,
      ip: ctx.ip,
      language: (header(ctx.req, 'accept-language') ?? '').split(',')[0]?.trim() || null,
      country: header(ctx.req, 'cf-ipcountry') ?? header(ctx.req, 'x-vercel-ip-country') ?? header(ctx.req, 'x-country-code') ?? null,
      browserId,
      referrer: header(ctx.req, 'referer') ?? null,
      route: 'pending',
      linkUrl,
      secret: deps.secret,
    });
    isNewClick = true;
  }

  const hop = new URL(ctx.url.toString());
  hop.searchParams.delete(FLOW_PARAM);
  hop.searchParams.delete(MATCH_PARAM);
  const decision = decideRoute({
    app,
    data,
    tags: resolved?.tags ?? null,
    client,
    clickId,
    flow,
    linkUrl,
    requestPathAndQuery: `${hop.pathname}${hop.search}`,
    requestHost: ctx.host,
  });

  if (isNewClick && clickId && resolved) {
    const route = `${decision.kind}${'reason' in decision ? `:${decision.reason}` : ''}`;
    await updateClickRoute(deps.db, clickId, route);
    await logEvent(deps.db, {
      appId: app.id,
      kind: 'click',
      name: 'CLICK',
      linkId: resolved.link?.id ?? null,
      clickId,
      ...tagsFromData(publicLinkData(resolved)),
      platform: client.platform,
      data: { route, browser: client.browser, in_app: client.inApp },
    });
  }

  let page: Page;
  switch (decision.kind) {
    case 'redirect':
      redirect(ctx, decision.url, 307, headers);
      return;
    case 'ios_deepview':
      page = iosDeepviewPage(app, data, decision);
      break;
    case 'android_deepview':
      page = androidDeepviewPage(app, data, decision);
      break;
    case 'scheme_then_fallback':
      page = schemeThenFallbackPage(app, data, decision);
      break;
    case 'desktop':
    case 'bot':
      page = desktopPage(app, data, linkUrl, qrToSvg(encodeQr(linkUrl, 'M'), { margin: 2 }));
      break;
  }
  sendHtml(ctx, 200, page.html, { ...headers, ...page.headers });
}
