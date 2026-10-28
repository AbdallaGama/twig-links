import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ipPrefix } from '../src/matching.ts';
import { encodeQr, qrToPng, qrToSvg } from '../src/qr.ts';
import { majorMinor, parseUserAgent } from '../src/ua.ts';
import { UA } from './helpers.ts';

describe('parseUserAgent', () => {
  it('detects iOS version and device family', () => {
    const info = parseUserAgent(UA.iosSafari);
    assert.equal(info.platform, 'ios');
    assert.equal(info.osVersion, '18.5');
    assert.equal(info.model, 'iPhone');
    assert.equal(info.browser, 'safari');
    assert.equal(info.inApp, null);
  });

  it('detects in-app browsers', () => {
    assert.equal(parseUserAgent(UA.iosInstagram).inApp, 'instagram');
    assert.equal(parseUserAgent(UA.androidFacebook).inApp, 'facebook');
  });

  it('reads Android model, and treats Chrome reduced UA as unknown unless client hints exist', () => {
    const full = parseUserAgent(UA.androidChrome);
    assert.equal(full.model, 'Pixel 9');
    assert.equal(full.osVersion, '15');
    const reduced = parseUserAgent(UA.androidChromeReduced);
    assert.equal(reduced.model, null);
    assert.equal(reduced.osVersion, null);
    assert.equal(reduced.reducedUa, true);
    const hinted = parseUserAgent(UA.androidChromeReduced, { platformVersion: '"15.0.0"', model: '"Pixel 9"' });
    assert.equal(hinted.model, 'Pixel 9');
    assert.equal(hinted.osVersion, '15.0.0');
  });

  it('classifies desktop and bots', () => {
    assert.equal(parseUserAgent(UA.macChrome).platform, 'macos');
    assert.equal(parseUserAgent(UA.windowsEdge).browser, 'edge');
    assert.equal(parseUserAgent(UA.facebookBot).isBot, true);
    assert.equal(parseUserAgent(UA.iosSafari).isBot, false);
    assert.equal(parseUserAgent('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)').isBot, true);
  });

  it('normalises versions', () => {
    assert.equal(majorMinor('18.5.1'), '18.5');
    assert.equal(majorMinor('15'), '15.0');
    assert.equal(majorMinor(null), null);
  });
});

describe('ipPrefix', () => {
  it('uses /24 for IPv4 and /64 for IPv6', () => {
    assert.equal(ipPrefix('203.0.113.77'), '203.0.113');
    assert.equal(ipPrefix('2001:db8:85a3::8a2e:370:7334'), '2001:db8:85a3:0');
    assert.equal(ipPrefix('2001:0db8:0001:0002:0003:0004:0005:0006'), '2001:db8:1:2');
    assert.equal(ipPrefix('not-an-ip'), null);
  });
});

describe('QR encoder', () => {
  it('picks the smallest version and draws finder patterns', () => {
    const qr = encodeQr('hello', 'L');
    assert.equal(qr.version, 1);
    assert.equal(qr.size, 21);
    // Finder pattern: dark ring, light ring, dark 3x3 core.
    assert.equal(qr.modules[0]![0], true);
    assert.equal(qr.modules[1]![1], false);
    assert.equal(qr.modules[3]![3], true);
  });

  it('grows with the payload and renders SVG and PNG', async () => {
    const qr = encodeQr('https://links.shop.test/' + 'x'.repeat(200), 'M');
    assert.ok(qr.version >= 7);
    assert.ok(qrToSvg(qr).startsWith('<svg'));
    const png = await qrToPng(qr, { scale: 2 });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
