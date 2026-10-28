import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';

import 'models.dart';
import 'native.dart';
import 'transport.dart';

const String sdkVersion = '0.1.0';

const _kInstalled = 'twig_installed';
const _kDeviceToken = 'twig_device_token';
const _kIdentity = 'twig_identity';
const _kFirstSession = 'twig_first_session';

/// Entry point of the Twig SDK.
///
/// ```dart
/// await TwigLinks.instance.init(TwigConfig(
///   publicKey: 'tw_live_...',
///   apiUrl: Uri.parse('https://links.example.com'),
///   linkDomains: ['links.example.com', 'open.example.com'],
/// ));
/// TwigLinks.instance.sessions.listen((session) {
///   if (session.clickedLink) router.go('/${session.deeplinkPath}');
/// });
/// ```
class TwigLinks {
  TwigLinks._(this._native, this._transport);

  static final TwigLinks instance = TwigLinks._(MethodChannelTwigNative(), httpTransport);

  /// For tests: inject fake native and network layers.
  @visibleForTesting
  factory TwigLinks.withDependencies({required TwigNative native, required TwigTransport transport}) =>
      TwigLinks._(native, transport);

  final TwigNative _native;
  final TwigTransport _transport;
  final StreamController<TwigSession> _sessions = StreamController<TwigSession>.broadcast();

  TwigConfig? _config;
  Future<TwigSession>? _initFuture;
  Future<void> _queue = Future<void>.value();
  Map<String, Object?> _device = const {};
  String? _deviceToken;
  String? _identity;
  TwigSession? _latest;
  DateTime _lastOpen = DateTime.fromMillisecondsSinceEpoch(0);
  StreamSubscription<String>? _linkSubscription;
  AppLifecycleListener? _lifecycle;
  Timer? _resumeTimer;

  /// Every session, starting with the one produced by [init]. Late listeners can
  /// read [latestSession].
  Stream<TwigSession> get sessions => _sessions.stream;

  TwigSession? get latestSession => _latest;

  /// Link data of the open that installed the app (persisted across launches).
  Future<TwigSession?> get firstSession async {
    final raw = (await _native.readStorage())[_kFirstSession];
    if (raw == null) return null;
    return TwigSession(data: (jsonDecode(raw) as Map).cast<String, Object?>());
  }

  /// Starts the SDK and resolves the link (if any) that opened the app. Safe to call more than once.
  Future<TwigSession> init(TwigConfig config) {
    return _initFuture ??= _init(config);
  }

  Future<TwigSession> _init(TwigConfig config) async {
    _config = config;
    final storage = await _native.readStorage();
    _deviceToken = storage[_kDeviceToken];
    _identity = storage[_kIdentity];
    final firstLaunch = storage[_kInstalled] != 'true';
    _device = await _safe(_native.getDeviceInfo, const <String, Object?>{});

    final initialLink = await _safe(_native.getInitialLink, null);
    _linkSubscription = _native.links.listen((url) => handleLink(url));

    String? referrer;
    String? pasteboard;
    if (firstLaunch) {
      final os = (_device['os'] as String? ?? '').toLowerCase();
      if (os == 'android') referrer = await _safe(_native.getInstallReferrer, null);
      if (os == 'ios' && config.checkPasteboardOnInstall && initialLink == null) {
        final candidate = await _safe(_native.readPasteboard, null);
        if (candidate != null && isTwigLink(candidate)) pasteboard = candidate;
      }
    }

    if (config.trackForegroundOpens) {
      try {
        _lifecycle = AppLifecycleListener(onResume: _onResume);
      } catch (_) {
        // No WidgetsBinding (e.g. called before runApp without ensureInitialized).
      }
    }

    return _enqueue(() => _open(
          linkUrl: initialLink,
          firstLaunch: firstLaunch,
          installReferrer: referrer,
          pasteboardUrl: pasteboard,
        ));
  }

  /// Reports a URL that opened the app. Called automatically for Universal Links,
  /// App Links and URI schemes; call it yourself only for URLs received elsewhere
  /// (push payloads, QR scanners inside the app, ...).
  Future<TwigSession> handleLink(String url) {
    _resumeTimer?.cancel();
    return _enqueue(() => _open(linkUrl: url, firstLaunch: false));
  }

  /// True when [url] is on one of the configured link domains.
  bool isTwigLink(String url) {
    final host = Uri.tryParse(url)?.host.toLowerCase();
    return host != null && (_config?.linkDomains.map((d) => d.toLowerCase()).contains(host) ?? false);
  }

  void _onResume() {
    _resumeTimer?.cancel();
    // A link that brought the app forward arrives right after resume; give it a moment.
    _resumeTimer = Timer(const Duration(milliseconds: 800), () {
      if (DateTime.now().difference(_lastOpen) < const Duration(seconds: 30)) return;
      _enqueue(() => _open(linkUrl: null, firstLaunch: false));
    });
  }

  Future<T> _enqueue<T>(Future<T> Function() task) {
    final completer = Completer<T>();
    _queue = _queue.then((_) async {
      try {
        completer.complete(await task());
      } catch (error, stack) {
        completer.completeError(error, stack);
      }
    });
    return completer.future;
  }

  Future<TwigSession> _open({required String? linkUrl, required bool firstLaunch, String? installReferrer, String? pasteboardUrl}) async {
    final config = _requireConfig();
    _lastOpen = DateTime.now();
    final body = <String, Object?>{
      'key': config.publicKey,
      ..._device,
      'sdk': 'flutter/$sdkVersion',
      'is_first_launch': firstLaunch,
      'device_token': ?_deviceToken,
      'identity': ?_identity,
      'link_url': ?linkUrl,
      'install_referrer': ?installReferrer,
      'pasteboard_url': ?pasteboardUrl,
    };
    TwigSession session;
    try {
      final json = await withRetry(_activeTransport, config.apiUrl.resolve('/v1/open'), body, config.requestTimeout);
      _log('open → $json');
      _deviceToken = json['device_token'] as String? ?? _deviceToken;
      final data = (json['data'] as Map? ?? const {}).cast<String, Object?>();
      session = TwigSession(data: data, sessionId: json['session_id'] as String?, openedUrl: linkUrl);
      await _native.writeStorage({
        _kInstalled: 'true',
        _kDeviceToken: ?_deviceToken,
        if (firstLaunch) _kFirstSession: jsonEncode(data),
      });
    } catch (error) {
      _log('open failed: $error');
      session = TwigSession(data: offlineData(linkUrl), openedUrl: linkUrl, error: error);
    }
    _latest = session;
    _sessions.add(session);
    return session;
  }

  /// Best-effort data when offline: long-link query parameters of a Twig URL.
  @visibleForTesting
  Map<String, Object?> offlineData(String? url) {
    final uri = url == null ? null : Uri.tryParse(url);
    if (uri == null) return const {'+clicked_link': false};
    final data = <String, Object?>{};
    uri.queryParameters.forEach((key, value) {
      if (key.startsWith('+') || key == 'link_click_id' || key.startsWith('_twig') || key.startsWith('__twig')) return;
      data[key] = value;
    });
    if (!isTwigLink(url!)) return {'+clicked_link': false, '+non_twig_link': url};
    return {...data, '+clicked_link': true, '+match_type': 'offline', '~referring_link': url};
  }

  /// Creates a short link. Falls back to a long link (no network needed) if the server is unreachable.
  Future<String> createLink(TwigLinkOptions options) async {
    final config = _requireConfig();
    try {
      final json = await withRetry(_activeTransport, config.apiUrl.resolve('/v1/url'), {'key': config.publicKey, ...options.toJson()}, config.requestTimeout);
      return json['url'] as String;
    } catch (error) {
      _log('createLink failed, using long link: $error');
      return longLink(options);
    }
  }

  /// A link that carries its data in the query string; works without any API call.
  String longLink(TwigLinkOptions options) {
    final config = _requireConfig();
    if (config.linkDomains.isEmpty) throw const TwigException('no_link_domain');
    final params = <String, String>{};
    options.data.forEach((key, value) {
      if (value != null) params[key] = value is String ? value : jsonEncode(value);
    });
    if (options.channel != null) params['~channel'] = options.channel!;
    if (options.feature != null) params['~feature'] = options.feature!;
    if (options.campaign != null) params['~campaign'] = options.campaign!;
    if (options.stage != null) params['~stage'] = options.stage!;
    if (options.tags.isNotEmpty) params['~tags'] = options.tags.join(',');
    return Uri.https(config.linkDomains.first, '/', params).toString();
  }

  /// Logs a standard (e.g. `PURCHASE`, `ADD_TO_CART`) or custom event, attributed
  /// to the last link that opened the app.
  Future<void> logEvent(
    String name, {
    double? revenue,
    String? currency,
    Map<String, Object?> data = const {},
    List<Map<String, Object?>> contentItems = const [],
  }) async {
    final config = _requireConfig();
    await (_initFuture ?? Future<void>.value());
    await _enqueue(() => withRetry(_activeTransport, config.apiUrl.resolve('/v1/event'), {
          'key': config.publicKey,
          'device_token': _deviceToken,
          'name': name,
          'os': _device['os'],
          'revenue': ?revenue,
          'currency': ?currency,
          if (data.isNotEmpty) 'data': data,
          if (contentItems.isNotEmpty) 'content_items': contentItems,
        }, config.requestTimeout));
  }

  /// Associates your user id with this device (sent with later opens and events).
  Future<void> setIdentity(String identity) => _setIdentity(identity);

  Future<void> logout() => _setIdentity(null);

  Future<void> _setIdentity(String? identity) async {
    final config = _requireConfig();
    _identity = identity;
    await _native.writeStorage({_kIdentity: identity});
    await (_initFuture ?? Future<void>.value());
    if (_deviceToken == null) return;
    await _enqueue(() => withRetry(_activeTransport, config.apiUrl.resolve('/v1/identity'),
        {'key': config.publicKey, 'device_token': _deviceToken, 'identity': identity}, config.requestTimeout));
  }

  /// URL of a QR code image for [linkUrl] (must be on one of your link domains).
  Uri qrCodeUri(String linkUrl, {String format = 'png', int scale = 8}) =>
      _requireConfig().apiUrl.replace(path: '/v1/qr', queryParameters: {'url': linkUrl, 'format': format, 'scale': '$scale'});

  TwigTransport get _activeTransport => _config?.transport ?? _transport;

  TwigConfig _requireConfig() {
    final config = _config;
    if (config == null) throw const TwigException('not_initialized', 'Call TwigLinks.instance.init() first');
    return config;
  }

  Future<T> _safe<T>(Future<T> Function() call, T fallback) async {
    try {
      return await call();
    } catch (error) {
      _log('native call failed: $error');
      return fallback;
    }
  }

  void _log(String message) {
    if (_config?.debug ?? false) debugPrint('[twig] $message');
  }

  /// Stops listening for links. Mainly for tests.
  @visibleForTesting
  Future<void> dispose() async {
    _resumeTimer?.cancel();
    _lifecycle?.dispose();
    await _linkSubscription?.cancel();
    await _sessions.close();
  }
}
