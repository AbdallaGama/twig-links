import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:twig_links/twig_links.dart';

class FakeNative implements TwigNative {
  FakeNative({this.initialLink, this.os = 'iOS', this.referrer, this.pasteboard});

  final String? initialLink;
  final String os;
  final String? referrer;
  final String? pasteboard;
  final Map<String, String> storage = {};
  final StreamController<String> controller = StreamController<String>.broadcast();
  int pasteboardReads = 0;

  @override
  Future<String?> getInitialLink() async => initialLink;

  @override
  Stream<String> get links => controller.stream;

  @override
  Future<Map<String, Object?>> getDeviceInfo() async => {'os': os, 'os_version': '18.5', 'model': 'iPhone15,2', 'hardware_id': 'hw-1'};

  @override
  Future<String?> getInstallReferrer() async => referrer;

  @override
  Future<String?> readPasteboard() async {
    pasteboardReads++;
    return pasteboard;
  }

  @override
  Future<Map<String, String>> readStorage() async => Map.of(storage);

  @override
  Future<void> writeStorage(Map<String, String?> values) async {
    values.forEach((key, value) => value == null ? storage.remove(key) : storage[key] = value);
  }
}

class Call {
  Call(this.url, this.body);
  final Uri url;
  final Map<String, Object?> body;
}

TwigConfig config({bool pasteboard = false}) => TwigConfig(
      publicKey: 'tw_live_test',
      apiUrl: Uri.parse('https://api.shop.test'),
      linkDomains: const ['links.shop.test', 'open.shop.test'],
      checkPasteboardOnInstall: pasteboard,
      trackForegroundOpens: false,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<Call> calls;
  late Map<String, Object?> Function(Call call) responder;

  Future<Map<String, Object?>> transport(Uri url, Map<String, Object?> body, Duration timeout) async {
    final call = Call(url, body);
    calls.add(call);
    return responder(call);
  }

  setUp(() {
    calls = [];
    responder = (call) => {
          'session_id': 'se_1',
          'device_token': 'dv_1',
          'data': {'+clicked_link': true, '+is_first_session': call.body['is_first_launch'], r'$deeplink_path': 'product/42', '~channel': 'whatsapp'},
        };
  });

  test('first launch sends the initial link and install flags, then persists state', () async {
    final native = FakeNative(initialLink: 'https://links.shop.test/AbC');
    final twig = TwigLinks.withDependencies(native: native, transport: transport);
    final session = await twig.init(config());

    expect(calls.single.url.toString(), 'https://api.shop.test/v1/open');
    expect(calls.single.body['is_first_launch'], true);
    expect(calls.single.body['link_url'], 'https://links.shop.test/AbC');
    expect(calls.single.body['key'], 'tw_live_test');
    expect(calls.single.body['sdk'], 'flutter/$sdkVersion');
    expect(session.clickedLink, isTrue);
    expect(session.deeplinkPath, 'product/42');
    expect(session.channel, 'whatsapp');
    expect(native.storage['twig_installed'], 'true');
    expect(native.storage['twig_device_token'], 'dv_1');
    expect((await twig.firstSession)?.deeplinkPath, 'product/42');
  });

  test('later launches send the device token and are not first launches', () async {
    final native = FakeNative()..storage.addAll({'twig_installed': 'true', 'twig_device_token': 'dv_9'});
    final twig = TwigLinks.withDependencies(native: native, transport: transport);
    await twig.init(config());
    expect(calls.single.body['is_first_launch'], false);
    expect(calls.single.body['device_token'], 'dv_9');
  });

  test('Android first launch forwards the Play install referrer', () async {
    final native = FakeNative(os: 'Android', referrer: 'link_click_id=1730000000000123456');
    await TwigLinks.withDependencies(native: native, transport: transport).init(config());
    expect(calls.single.body['install_referrer'], 'link_click_id=1730000000000123456');
  });

  test('iOS pasteboard is read only when enabled, and only Twig links are sent', () async {
    final off = FakeNative(pasteboard: 'https://links.shop.test/AbC?link_click_id=1');
    await TwigLinks.withDependencies(native: off, transport: transport).init(config());
    expect(off.pasteboardReads, 0);

    calls.clear();
    final on = FakeNative(pasteboard: 'https://links.shop.test/AbC?link_click_id=1');
    await TwigLinks.withDependencies(native: on, transport: transport).init(config(pasteboard: true));
    expect(calls.single.body['pasteboard_url'], 'https://links.shop.test/AbC?link_click_id=1');

    calls.clear();
    final foreign = FakeNative(pasteboard: 'https://evil.test/x');
    await TwigLinks.withDependencies(native: foreign, transport: transport).init(config(pasteboard: true));
    expect(calls.single.body.containsKey('pasteboard_url'), isFalse);
  });

  test('links that arrive while running produce new sessions', () async {
    final native = FakeNative();
    final twig = TwigLinks.withDependencies(native: native, transport: transport);
    await twig.init(config());
    final next = twig.sessions.first;
    native.controller.add('shop://product/7?link_click_id=1730000000000999999');
    final session = await next;
    expect(calls.last.body['link_url'], 'shop://product/7?link_click_id=1730000000000999999');
    expect(session.openedUrl, 'shop://product/7?link_click_id=1730000000000999999');
  });

  test('offline opens fall back to data parsed from long links', () async {
    responder = (_) => throw const TwigException('http_503');
    final native = FakeNative(initialLink: r'https://links.shop.test/?$deeplink_path=cart&coupon=X1&link_click_id=5');
    final twig = TwigLinks.withDependencies(native: native, transport: transport);
    final session = await twig.init(config());
    expect(session.error, isA<TwigException>());
    expect(session.clickedLink, isTrue);
    expect(session.get<String>('coupon'), 'X1');
    expect(session.data.containsKey('link_click_id'), isFalse);
    expect(calls.length, 3, reason: 'two retries on 5xx');
  });

  test('createLink returns the short link or a long link when offline', () async {
    final twig = TwigLinks.withDependencies(native: FakeNative(), transport: transport);
    await twig.init(config());
    responder = (call) => {'url': 'https://links.shop.test/Short1', 'code': 'Short1'};
    const options = TwigLinkOptions(data: {r'$deeplink_path': 'product/42', 'id': 42}, channel: 'sms', tags: ['a', 'b']);
    expect(await twig.createLink(options), 'https://links.shop.test/Short1');
    expect(calls.last.body['channel'], 'sms');

    responder = (_) => throw const TwigException('http_500');
    final long = Uri.parse(await twig.createLink(options));
    expect(long.host, 'links.shop.test');
    expect(long.queryParameters[r'$deeplink_path'], 'product/42');
    expect(long.queryParameters['id'], '42');
    expect(long.queryParameters['~tags'], 'a,b');
  });

  test('client errors are not retried', () async {
    final twig = TwigLinks.withDependencies(native: FakeNative(), transport: transport);
    await twig.init(config());
    calls.clear();
    responder = (_) => throw const TwigException('invalid_key');
    await expectLater(twig.logEvent('PURCHASE', revenue: 9.99, currency: 'USD'), throwsA(isA<TwigException>()));
    expect(calls.length, 1);
    expect(calls.single.body['revenue'], 9.99);
    expect(calls.single.body['device_token'], 'dv_1');
  });

  test('identity is stored and sent to the server', () async {
    final native = FakeNative();
    final twig = TwigLinks.withDependencies(native: native, transport: transport);
    await twig.init(config());
    responder = (_) => {'ok': true};
    await twig.setIdentity('user-7');
    expect(calls.last.url.path, '/v1/identity');
    expect(calls.last.body['identity'], 'user-7');
    expect(native.storage['twig_identity'], 'user-7');
    await twig.logout();
    expect(calls.last.body['identity'], isNull);
    expect(native.storage.containsKey('twig_identity'), isFalse);
  });

  test('a transport in the config replaces the default one', () async {
    final custom = <Uri>[];
    final twig = TwigLinks.withDependencies(native: FakeNative(), transport: transport);
    await twig.init(TwigConfig(
      publicKey: 'tw_live_test',
      apiUrl: Uri.parse('https://api.shop.test'),
      linkDomains: const ['links.shop.test'],
      trackForegroundOpens: false,
      transport: (url, body, timeout) async {
        custom.add(url);
        return {'device_token': 'dv_2', 'data': <String, Object?>{}};
      },
    ));
    expect(custom.single.path, '/v1/open');
    expect(calls, isEmpty);
  });

  test('qrCodeUri points at the server QR endpoint', () async {
    final twig = TwigLinks.withDependencies(native: FakeNative(), transport: transport);
    await twig.init(config());
    final uri = twig.qrCodeUri('https://links.shop.test/AbC', format: 'svg');
    expect(uri.toString(), 'https://api.shop.test/v1/qr?url=https%3A%2F%2Flinks.shop.test%2FAbC&format=svg&scale=8');
  });
}
