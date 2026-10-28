# twig_links

Universal Links, Android App Links and deferred deep linking for Flutter — backed by
**Twig**, an open-source, self-hosted deep linking server you run on Cloudflare Workers or Node.

- **Open the right screen:** a tapped link opens the app directly on its content.
- **Deferred deep linking:** without the app, the link goes to the App Store / Google Play, and the
  first launch after install opens the same content (Play install referrer, iOS pasteboard, fingerprint).
- **Share links with previews:** create readable short links whose WhatsApp / iMessage preview shows
  your title, description and image.
- **Analytics:** clicks, installs, opens and events per link in the Twig dashboard.
- No Dart dependencies; bring your own HTTP client if you need one.

> You need a Twig server. Deploy it from the
> [repository](https://github.com/AbdallaGama/twig-links) — see
> [the deployment guide](https://github.com/AbdallaGama/twig-links/blob/main/docs/03-deployment.md).

## Install

```yaml
dependencies:
  twig_links: ^0.1.0
```

Requires Flutter 3.38+ (iOS 15+, Android 7.0 / API 24+).

## Platform setup

**iOS** — Xcode → Signing & Capabilities → Associated Domains:

```
applinks:go.yourname.workers.dev
applinks:open.yourname.workers.dev
```

In `Info.plist`, add your URL scheme (`CFBundleURLTypes`) and set `FlutterDeepLinkingEnabled` to `false`.

**Android** — inside the launcher `<activity>` of `AndroidManifest.xml`:

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="go.yourname.workers.dev" />
  <data android:scheme="https" android:host="open.yourname.workers.dev" />
</intent-filter>
<meta-data android:name="flutter_deeplinking_enabled" android:value="false" />
```

Fill in your Team ID, bundle ID, package name and SHA-256 fingerprints in the Twig dashboard; it
serves `apple-app-site-association` and `assetlinks.json` on your link domains automatically.

## Usage

```dart
import 'package:twig_links/twig_links.dart';

await TwigLinks.instance.init(TwigConfig(
  publicKey: 'tw_live_…', // dashboard → Integrate (publishable, not secret)
  apiUrl: Uri.parse('https://go.yourname.workers.dev'),
  linkDomains: const ['go.yourname.workers.dev', 'open.yourname.workers.dev'],
  checkPasteboardOnInstall: true, // exact deferred deep links on iOS
));

// Every app open, including the first one after install.
TwigLinks.instance.sessions.listen((session) {
  if (session.clickedLink && session.deeplinkPath != null) {
    router.go('/${session.deeplinkPath}'); // e.g. "p/42"
  }
});

// A readable share link with a rich preview.
final url = await TwigLinks.instance.createLink(const TwigLinkOptions(
  alias: 'red-running-shoes',
  data: {
    r'$deeplink_path': 'p/42',
    r'$og_title': 'Red Running Shoes',
    r'$og_description': 'Check out this amazing product!',
    r'$og_image_url': 'https://example.com/red-shoes.jpg',
  },
  channel: 'app_share',
));

// Events and identity.
await TwigLinks.instance.logEvent('PURCHASE', revenue: 9.99, currency: 'USD');
await TwigLinks.instance.setIdentity('user-42');
```

`TwigSession` exposes `clickedLink`, `isFirstSession`, `matchGuaranteed`, `matchType`,
`deeplinkPath`, `channel`, `campaign` and the raw `data`. `createLink` falls back to a long link
when the server cannot be reached, so sharing never fails.

### Custom HTTP client

```dart
TwigConfig(
  // …
  transport: (url, body, timeout) async =>
      (await dio.postUri<Map<String, Object?>>(url, data: body)).data ?? const {},
);
```

## More

- [Full integration guide](https://github.com/AbdallaGama/twig-links/blob/main/docs/02-integration-guide.md)
  (Flutter, native iOS and Android SDKs, web SDK, server API)
- [Architecture and wire protocol](https://github.com/AbdallaGama/twig-links/blob/main/docs/01-architecture.md)
- A configured example app is in [`example/`](example/).

Licensed under MIT.
