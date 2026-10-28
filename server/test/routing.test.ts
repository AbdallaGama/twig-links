import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendQuery, decideRoute, intentUrl, playStoreUrl, type RouteInput } from '../src/routing.ts';
import { parseUserAgent } from '../src/ua.ts';
import { testApp, UA } from './helpers.ts';

function input(ua: string, data: Record<string, unknown> = {}, extra: Partial<RouteInput> = {}): RouteInput {
  return {
    app: testApp(),
    data,
    tags: { channel: 'whatsapp', feature: 'share', campaign: 'summer', stage: null, tags: [] },
    client: parseUserAgent(ua),
    clickId: '1730000000000123456',
    flow: null,
    linkUrl: 'https://links.shop.test/AbC123',
    requestPathAndQuery: '/AbC123',
    requestHost: 'links.shop.test',
    ...extra,
  };
}

describe('decideRoute — the selection logic', () => {
  it('serves crawlers a preview page and records nothing', () => {
    assert.deepEqual(decideRoute(input(UA.facebookBot)), { kind: 'bot' });
    assert.deepEqual(decideRoute(input(UA.iMessage)), { kind: 'bot' });
    assert.deepEqual(decideRoute(input(UA.whatsapp)), { kind: 'bot' });
  });

  it('iOS Safari gets the copy-link interstitial that hops to the alternate domain', () => {
    const decision = decideRoute(input(UA.iosSafari, { $deeplink_path: 'product/42' }));
    assert.equal(decision.kind, 'ios_interstitial');
    if (decision.kind !== 'ios_interstitial') return;
    assert.equal(decision.continueUrl, 'https://open.shop.test/AbC123?__twig_flow=store&_twig_match_id=1730000000000123456');
    assert.equal(decision.copyUrl, 'https://links.shop.test/AbC123?link_click_id=1730000000000123456');
    assert.equal(decision.storeUrl, 'https://apps.apple.com/app/id123456789');
  });

  it('iOS in-app browsers get the same interstitial', () => {
    assert.equal(decideRoute(input(UA.iosInstagram)).kind, 'ios_interstitial');
  });

  it('the store hop on the alternate domain redirects to the App Store', () => {
    assert.deepEqual(decideRoute(input(UA.iosSafari, {}, { flow: 'store', requestHost: 'open.shop.test' })), {
      kind: 'redirect', url: 'https://apps.apple.com/app/id123456789', reason: 'ios_store_hop',
    });
  });

  it('iOS goes straight to the store when the interstitial is disabled', () => {
    const decision = decideRoute(input(UA.iosSafari, { $ios_interstitial: 'false' }));
    assert.deepEqual(decision, { kind: 'redirect', url: 'https://apps.apple.com/app/id123456789', reason: 'ios_app_store' });
  });

  it('$ios_url and $ipad_url override the store and carry the match id', () => {
    assert.deepEqual(decideRoute(input(UA.iosSafari, { $ios_url: 'https://shop.test/ios' })), {
      kind: 'redirect', url: 'https://shop.test/ios?_twig_match_id=1730000000000123456', reason: 'ios_url',
    });
    const ipad = decideRoute(input(UA.ipad, { $ios_url: 'https://shop.test/ios', $ipad_url: 'https://shop.test/ipad' }));
    assert.equal(ipad.kind === 'redirect' && ipad.url, 'https://shop.test/ipad?_twig_match_id=1730000000000123456');
  });

  it('$uri_redirect_mode=2 tries the URI scheme before the store', () => {
    const decision = decideRoute(input(UA.iosSafari, { $uri_redirect_mode: '2', $deeplink_path: 'cart' }));
    assert.equal(decision.kind, 'scheme_then_fallback');
    if (decision.kind !== 'scheme_then_fallback') return;
    assert.equal(decision.schemeUrl, 'shop://cart?link_click_id=1730000000000123456');
    assert.equal(decision.fallbackUrl, 'https://apps.apple.com/app/id123456789');
  });

  it('Android Chrome gets an intent with a Play Store fallback carrying the install referrer', () => {
    const decision = decideRoute(input(UA.androidChrome, { $deeplink_path: 'product/42', $android_deeplink_path: 'p/42' }));
    assert.equal(decision.kind, 'redirect');
    if (decision.kind !== 'redirect') return;
    assert.equal(decision.reason, 'android_intent');
    assert.ok(decision.url.startsWith('intent://p/42?link_click_id=1730000000000123456#Intent;scheme=shop;package=com.shop.app;'));
    const fallback = decodeURIComponent(/S\.browser_fallback_url=([^;]+)/.exec(decision.url)![1]!);
    const referrer = new URL(fallback).searchParams.get('referrer');
    assert.equal(referrer, 'link_click_id=1730000000000123456&utm_source=whatsapp&utm_medium=share&utm_campaign=summer');
    assert.match(decision.url, /S\.market_referrer=link_click_id%3D1730000000000123456;end$/);
  });

  it('Android in-app browsers get an interstitial page instead of a blocked intent', () => {
    const decision = decideRoute(input(UA.androidFacebook));
    assert.equal(decision.kind, 'android_interstitial');
  });

  it('Android without a URI scheme falls back to an https App Link intent', () => {
    const app = testApp({ android: { packageName: 'com.shop.app', uriScheme: null } });
    const decision = decideRoute({ ...input(UA.androidChrome), app });
    assert.equal(decision.kind === 'redirect' && decision.url.split('#')[0], 'intent://links.shop.test/AbC123?link_click_id=1730000000000123456');
    assert.ok(decision.kind === 'redirect' && decision.url.includes(';scheme=https;'));
  });

  it('$android_url replaces the store as the intent fallback', () => {
    const decision = decideRoute(input(UA.androidChrome, { $android_url: 'https://shop.test/android' }));
    assert.ok(decision.kind === 'redirect');
    if (decision.kind !== 'redirect') return;
    const fallback = decodeURIComponent(/S\.browser_fallback_url=([^;]+)/.exec(decision.url)![1]!);
    assert.equal(fallback, 'https://shop.test/android?_twig_match_id=1730000000000123456');
  });

  it('$web_only forces the web on every platform', () => {
    for (const ua of [UA.iosSafari, UA.androidChrome, UA.macChrome]) {
      const decision = decideRoute(input(ua, { $web_only: 'true', $fallback_url: 'https://shop.test/web' }));
      assert.equal(decision.kind, 'redirect');
      assert.ok(decision.kind === 'redirect' && decision.url.includes('_twig_match_id='));
    }
    const ios = decideRoute(input(UA.iosSafari, { $web_only: true, $ios_url: 'https://shop.test/ios-web' }));
    assert.equal(ios.kind === 'redirect' && ios.url, 'https://shop.test/ios-web?_twig_match_id=1730000000000123456');
  });

  it('desktop prefers $desktop_url, then the app desktop URL, then a QR page', () => {
    assert.deepEqual(decideRoute(input(UA.macChrome, { $desktop_url: 'https://shop.test/p/42' })), {
      kind: 'redirect', url: 'https://shop.test/p/42?_twig_match_id=1730000000000123456', reason: 'desktop_url',
    });
    const appDefault = decideRoute(input(UA.windowsEdge));
    assert.equal(appDefault.kind === 'redirect' && appDefault.url, 'https://shop.test/?_twig_match_id=1730000000000123456');
    const bare = testApp({ desktopUrl: null, fallbackUrl: null });
    assert.deepEqual(decideRoute({ ...input(UA.macChrome), app: bare }), { kind: 'desktop', reason: 'desktop_page' });
  });

  it('apps without store listings fall back to the web', () => {
    const app = testApp({ ios: { appStoreId: null }, android: { packageName: null } });
    const ios = decideRoute({ ...input(UA.iosSafari), app });
    assert.equal(ios.kind === 'redirect' && ios.reason, 'ios_no_store');
    const android = decideRoute({ ...input(UA.androidChrome), app });
    assert.equal(android.kind === 'redirect' && android.reason, 'android_no_app');
  });
});

describe('URL helpers', () => {
  it('appendQuery keeps fragments and existing queries', () => {
    assert.equal(appendQuery('https://a.test/x#frag', { a: '1' }), 'https://a.test/x?a=1#frag');
    assert.equal(appendQuery('https://a.test/x?b=2', { a: '1', c: null }), 'https://a.test/x?b=2&a=1');
    assert.equal(appendQuery('shop://open', { link_click_id: '9' }), 'shop://open?link_click_id=9');
  });

  it('playStoreUrl encodes the referrer once', () => {
    const url = playStoreUrl(testApp(), '42', null)!;
    assert.equal(url, 'https://play.google.com/store/apps/details?id=com.shop.app&referrer=link_click_id%3D42');
  });

  it('intentUrl merges deeplink path queries', () => {
    const url = intentUrl({ scheme: 'shop', path: 'p?x=1', httpsTarget: null, packageName: 'com.shop.app', clickId: '7', fallbackUrl: 'https://f.test' });
    assert.ok(url!.startsWith('intent://p?x=1&link_click_id=7#Intent;scheme=shop;package=com.shop.app;'));
  });
});
