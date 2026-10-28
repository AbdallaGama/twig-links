import type { App } from './apps.ts';
import { alternateHost, appStoreUrl, primaryHost } from './apps.ts';
import type { LinkData, LinkTags } from './links.ts';
import type { ClientInfo } from './ua.ts';

/**
 * The selection logic: given a link, the app's configuration and the client that clicked,
 * decide where the click goes. Pure and synchronous so every branch is unit-testable.
 *
 * Reached only when the OS did NOT open the app directly. When the app is installed and
 * Universal Links / App Links are honoured, iOS/Android open the app without contacting
 * this server and the SDK reports the URL itself.
 */
export interface RouteInput {
  app: App;
  data: LinkData;
  tags: LinkTags | null;
  client: ClientInfo;
  /** Null for clicks we do not record (unknown links). */
  clickId: string | null;
  /** Second-hop marker set by our own interstitial pages (?__twig_flow=store). */
  flow: string | null;
  /** Canonical link URL on the primary domain, without flow parameters. */
  linkUrl: string;
  /** Path + query of the incoming request (used to build the alternate-domain hop). */
  requestPathAndQuery: string;
  requestHost: string;
}

export type RouteDecision =
  | { kind: 'bot' }
  | { kind: 'redirect'; url: string; reason: string }
  | { kind: 'ios_deepview'; continueUrl: string; copyUrl: string; storeUrl: string; reason: string }
  | { kind: 'android_deepview'; storeUrl: string; intentUrl: string | null; reason: string }
  | { kind: 'scheme_then_fallback'; schemeUrl: string; fallbackUrl: string; timeoutMs: number; reason: string }
  | { kind: 'desktop'; reason: string };

export const MATCH_PARAM = '_twig_match_id';
export const FLOW_PARAM = '__twig_flow';

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function isWebUrl(value: string | null): value is string {
  return value !== null && /^https?:\/\//i.test(value);
}

/** Appends query parameters to any URL (web or custom scheme), keeping a #fragment last. */
export function appendQuery(url: string, params: Record<string, string | null | undefined>): string {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  if (pairs.length === 0) return url;
  const hashIndex = url.indexOf('#');
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const separator = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return `${base}${separator}${pairs.join('&')}${hash}`;
}

export function playStoreUrl(app: App, clickId: string | null, tags: LinkTags | null): string | null {
  const pkg = app.config.android.packageName;
  const base = app.config.android.playStoreUrl ?? (pkg ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}` : null);
  if (!base) return null;
  const referrer = new URLSearchParams();
  if (clickId) referrer.set('link_click_id', clickId);
  if (tags?.channel) referrer.set('utm_source', tags.channel);
  if (tags?.feature) referrer.set('utm_medium', tags.feature);
  if (tags?.campaign) referrer.set('utm_campaign', tags.campaign);
  const value = referrer.toString();
  return value ? appendQuery(base, { referrer: value }) : base;
}

function deeplinkPath(data: LinkData, platform: 'ios' | 'android'): string {
  const path = text(data[`$${platform}_deeplink_path`]) ?? text(data.$deeplink_path) ?? 'open';
  return path.replace(/^\/+/, '');
}

export function schemeUrl(scheme: string, path: string, clickId: string | null): string {
  return appendQuery(`${scheme}://${path}`, { link_click_id: clickId });
}

/**
 * Android intent URL. With a custom scheme it targets scheme://path; without one it uses
 * the https link itself so an App Link intent filter can still catch it. Chrome opens the
 * app when installed, otherwise navigates to browser_fallback_url (the Play Store with an
 * install referrer carrying the click id → deterministic deferred deep link).
 */
export function intentUrl(options: { scheme: string | null; path: string; httpsTarget: string | null; packageName: string; clickId: string | null; fallbackUrl: string }): string | null {
  let target: string;
  let scheme: string;
  if (options.scheme) {
    target = appendQuery(options.path, { link_click_id: options.clickId });
    scheme = options.scheme;
  } else if (options.httpsTarget) {
    const url = new URL(options.httpsTarget);
    target = appendQuery(`${url.host}${url.pathname}${url.search}`, { link_click_id: options.clickId });
    scheme = 'https';
  } else {
    return null;
  }
  const extras = [
    `scheme=${scheme}`,
    `package=${options.packageName}`,
    `S.browser_fallback_url=${encodeURIComponent(options.fallbackUrl)}`,
  ];
  if (options.clickId) extras.push(`S.market_referrer=${encodeURIComponent(`link_click_id=${options.clickId}`)}`);
  return `intent://${target}#Intent;${extras.join(';')};end`;
}

export function decideRoute(input: RouteInput): RouteDecision {
  const { app, data, client, clickId, tags } = input;
  if (client.isBot) return { kind: 'bot' };

  const config = app.config;
  const withMatch = (url: string) => appendQuery(url, { [MATCH_PARAM]: clickId });
  const desktopTarget = text(data.$desktop_url) ?? config.desktopUrl;
  const fallbackTarget = text(data.$fallback_url) ?? config.fallbackUrl;

  // $web_only: never open the app (the AASA also excludes these URLs).
  if (truthy(data.$web_only)) {
    const platformUrl = client.platform === 'ios' ? text(data.$ios_url) : client.platform === 'android' ? text(data.$android_url) : null;
    const target = [platformUrl, client.isMobile ? fallbackTarget : desktopTarget, fallbackTarget, desktopTarget].find(isWebUrl);
    return target ? { kind: 'redirect', url: withMatch(target), reason: 'web_only' } : { kind: 'desktop', reason: 'web_only_no_url' };
  }

  if (client.platform === 'ios') {
    const iosUrl = (client.model === 'iPad' ? text(data.$ipad_url) : null) ?? text(data.$ios_url);
    if (isWebUrl(iosUrl)) return { kind: 'redirect', url: withMatch(iosUrl), reason: 'ios_url' };

    const store = appStoreUrl(app);
    if (!store) {
      const web = [config.ios.redirectUrl, fallbackTarget, desktopTarget].find(isWebUrl);
      return web ? { kind: 'redirect', url: withMatch(web), reason: 'ios_no_store' } : { kind: 'desktop', reason: 'ios_unconfigured' };
    }

    if (input.flow === 'store') return { kind: 'redirect', url: store, reason: 'ios_store_hop' };

    const scheme = config.ios.uriScheme;
    if (scheme && text(data.$uri_redirect_mode) === '2') {
      return {
        kind: 'scheme_then_fallback',
        schemeUrl: schemeUrl(scheme, deeplinkPath(data, 'ios'), clickId),
        fallbackUrl: store,
        timeoutMs: Number(text(data.$ios_redirect_timeout) ?? 2500) || 2500,
        reason: 'ios_uri_scheme',
      };
    }

    const override = text(data.$ios_deepview);
    const deepview = override === 'false' || override === 'none' ? 'none' : config.ios.deepview;
    if (deepview === 'nativelink') {
      // Second hop on the alternate domain gives the Universal Link another chance: iOS
      // ignores Universal Links for navigations that stay on the same domain.
      const alternate = alternateHost(app);
      const hopHost = alternate && alternate !== input.requestHost ? alternate : input.requestHost;
      const continueUrl = appendQuery(`https://${hopHost}${input.requestPathAndQuery}`, { [FLOW_PARAM]: 'store', [MATCH_PARAM]: clickId });
      return {
        kind: 'ios_deepview',
        continueUrl,
        copyUrl: appendQuery(input.linkUrl, { link_click_id: clickId }),
        storeUrl: store,
        reason: 'ios_nativelink',
      };
    }
    return { kind: 'redirect', url: store, reason: 'ios_app_store' };
  }

  if (client.platform === 'android') {
    const pkg = config.android.packageName;
    const androidUrl = text(data.$android_url);
    if (!pkg) {
      const web = [androidUrl, config.android.redirectUrl, fallbackTarget, desktopTarget].find(isWebUrl);
      return web ? { kind: 'redirect', url: withMatch(web), reason: 'android_no_app' } : { kind: 'desktop', reason: 'android_unconfigured' };
    }
    const store = playStoreUrl(app, clickId, tags)!;
    const webFallback = [androidUrl, config.android.redirectUrl].find(isWebUrl);
    const fallback = webFallback ? withMatch(webFallback) : store;
    const intent = intentUrl({
      scheme: config.android.uriScheme,
      path: deeplinkPath(data, 'android'),
      httpsTarget: primaryHost(app) ? input.linkUrl : null,
      packageName: pkg,
      clickId,
      fallbackUrl: fallback,
    });
    // In-app browsers (Facebook, Instagram, WebViews) block intent:// navigation.
    if (client.inApp || !intent) return { kind: 'android_deepview', storeUrl: fallback, intentUrl: intent, reason: client.inApp ? 'android_in_app' : 'android_no_intent' };
    return { kind: 'redirect', url: intent, reason: 'android_intent' };
  }

  const desktopFirst = client.platform === 'other' ? [fallbackTarget, desktopTarget] : [desktopTarget, fallbackTarget];
  const target = desktopFirst.find(isWebUrl);
  if (target) return { kind: 'redirect', url: withMatch(target), reason: client.platform === 'other' ? 'fallback_url' : 'desktop_url' };
  return { kind: 'desktop', reason: 'desktop_page' };
}
