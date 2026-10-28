import 'transport.dart';

/// Configuration passed to [TwigLinks.init].
class TwigConfig {
  const TwigConfig({
    required this.publicKey,
    required this.apiUrl,
    required this.linkDomains,
    this.checkPasteboardOnInstall = false,
    this.trackForegroundOpens = true,
    this.requestTimeout = const Duration(seconds: 10),
    this.debug = false,
    this.transport,
  });

  /// The app's public SDK key (`tw_live_...`) from the Twig dashboard.
  final String publicKey;

  /// Base URL of your Twig server, e.g. `https://links.example.com`.
  final Uri apiUrl;

  /// Link domains of this app (primary first), e.g. `['links.example.com', 'open.example.com']`.
  /// Used to recognise Twig links and to build offline long links.
  final List<String> linkDomains;

  /// iOS only: on the first launch after install, read a Twig link that the
  /// interstitial page copied to the pasteboard (deterministic deferred deep link).
  /// iOS shows its "Allow Paste" prompt, so enable it only if that fits your UX.
  final bool checkPasteboardOnInstall;

  /// Report an open each time the app returns to the foreground (throttled to 30 s).
  /// Needed to catch links that sent an installed user through the store.
  final bool trackForegroundOpens;

  final Duration requestTimeout;

  /// Prints requests and responses with `debugPrint`.
  final bool debug;

  /// Sends the SDK's JSON requests. Defaults to a `dart:io` client; apps with
  /// their own HTTP stack (for example a dedicated Dio client) can supply one.
  final TwigTransport? transport;
}

/// The result of an app open: link data plus `+` system flags.
class TwigSession {
  const TwigSession({
    required this.data,
    this.sessionId,
    this.openedUrl,
    this.error,
  });

  /// Everything the link carried: your custom keys, `$` control keys,
  /// `~` analytics tags and `+` system flags.
  final Map<String, Object?> data;

  final String? sessionId;

  /// The URL that opened the app, if any (Universal Link, App Link or URI scheme).
  final String? openedUrl;

  /// Set when the server could not be reached; [data] then holds what could be
  /// parsed locally from [openedUrl].
  final Object? error;

  /// True when this open was caused by a Twig link (directly or deferred).
  bool get clickedLink => data['+clicked_link'] == true;

  /// True on the first open after install.
  bool get isFirstSession => data['+is_first_session'] == true;

  /// False for probabilistic (fingerprint) matches.
  bool get matchGuaranteed => data['+match_guaranteed'] == true;

  /// click_id, universal_link, uri_scheme, install_referrer, pasteboard, fingerprint.
  String? get matchType => data['+match_type'] as String?;

  /// In-app route for this link (`$deeplink_path`), e.g. `product/42`.
  String? get deeplinkPath => data[r'$deeplink_path'] as String?;

  String? get referringLink => data['~referring_link'] as String?;
  String? get channel => data['~channel'] as String?;
  String? get feature => data['~feature'] as String?;
  String? get campaign => data['~campaign'] as String?;

  /// The app was opened by a URL that is not a Twig link (for example your website).
  String? get nonTwigLink => data['+non_twig_link'] as String?;

  T? get<T>(String key) {
    final value = data[key];
    return value is T ? value : null;
  }

  @override
  String toString() => 'TwigSession(clickedLink: $clickedLink, data: $data${error == null ? '' : ', error: $error'})';
}

/// Parameters for [TwigLinks.createLink].
class TwigLinkOptions {
  const TwigLinkOptions({
    this.data = const {},
    this.alias,
    this.channel,
    this.feature,
    this.campaign,
    this.stage,
    this.tags = const [],
  });

  /// Custom data plus optional control keys, e.g.
  /// `{r'$deeplink_path': 'product/42', r'$og_title': 'Red Shoes', 'product_id': '42'}`.
  final Map<String, Object?> data;

  /// Optional vanity path (`https://links.example.com/<alias>`).
  final String? alias;
  final String? channel;
  final String? feature;
  final String? campaign;
  final String? stage;
  final List<String> tags;

  Map<String, Object?> toJson() => {
        'data': data,
        'alias': ?alias,
        'channel': ?channel,
        'feature': ?feature,
        'campaign': ?campaign,
        'stage': ?stage,
        if (tags.isNotEmpty) 'tags': tags,
      };
}

class TwigException implements Exception {
  const TwigException(this.code, [this.message]);

  final String code;
  final String? message;

  @override
  String toString() => 'TwigException($code${message == null ? '' : ': $message'})';
}
