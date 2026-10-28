# Integration guide

Every app needs, from the dashboard:

* **Public key** `tw_live_…` (safe to ship in apps)
* **API URL** — your Twig server, e.g. `https://links-admin.example.com`
* **Link domains** — primary (e.g. `links.example.com`) and alternate (e.g. `open.example.com`)

Fill in **Settings → iOS** (Team ID, bundle IDs, App Store ID, URI scheme) and **Settings →
Android** (package name, SHA-256 signing fingerprints, URI scheme) first: the server builds the
association files and redirects from them.

Get the Android fingerprints from Play Console → *App integrity* (Play App Signing key **and**
upload key), or locally with `keytool -list -v -keystore <keystore>`.

## 1. Platform setup (same for Flutter and native)

### iOS — Associated Domains

Xcode → target → *Signing & Capabilities* → **Associated Domains**:

```
applinks:links.example.com
applinks:open.example.com
```

Optional URI scheme (Info.plist → URL Types), e.g. `myapp`. Verify the association file:

```bash
curl -s https://links.example.com/.well-known/apple-app-site-association
```

Apple fetches it through its CDN; after changing it, reinstall the app. While developing you can
add `?mode=developer` to the entitlement (`applinks:links.example.com?mode=developer`) and enable
*Associated Domains Development* in the device's developer settings.

### Android — App Links

Inside the launcher `<activity>` of `AndroidManifest.xml`:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="links.example.com" />
    <data android:scheme="https" android:host="open.example.com" />
</intent-filter>
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="myapp" />
</intent-filter>
```

Verify:

```bash
adb shell pm verify-app-links --re-verify com.example.app
```

```bash
adb shell pm get-app-links com.example.app
```

## 2. Flutter

`pubspec.yaml` (path or git dependency on this repository):

```yaml
dependencies:
  twig_links:
    git:
      url: https://github.com/your-org/twig.git
      path: sdk/flutter/twig_links
```

Requires Flutter 3.38+ (UIScene-aware plugin API). Disable Flutter's built-in deep linking so
Twig routes links (it does not consume URLs, so you may keep both if you prefer):

* Android manifest activity: `<meta-data android:name="flutter_deeplinking_enabled" android:value="false" />`
* iOS Info.plist: `FlutterDeepLinkingEnabled` = `NO`

```dart
import 'package:twig_links/twig_links.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  unawaited(TwigLinks.instance.init(TwigConfig(
    publicKey: 'tw_live_…',
    apiUrl: Uri.parse('https://links-admin.example.com'),
    linkDomains: const ['links.example.com', 'open.example.com'],
    checkPasteboardOnInstall: true, // iOS deterministic deferred deep links (shows "Allow Paste" once)
  )));
  runApp(const MyApp());
}

// anywhere (e.g. in your router setup)
TwigLinks.instance.sessions.listen((session) {
  if (session.clickedLink && session.deeplinkPath != null) {
    router.go('/${session.deeplinkPath}');
  }
});

// share
final url = await TwigLinks.instance.createLink(const TwigLinkOptions(
  data: {r'$deeplink_path': 'product/42', r'$og_title': 'Red Shoes', 'product_id': '42'},
  channel: 'whatsapp',
  feature: 'share',
));

// events, identity
await TwigLinks.instance.logEvent('PURCHASE', revenue: 49.5, currency: 'USD', data: {'order_id': 'A1'});
await TwigLinks.instance.setIdentity('user-42');
await TwigLinks.instance.logout();
```

`TwigSession` exposes `clickedLink`, `isFirstSession`, `matchGuaranteed`, `matchType`,
`deeplinkPath`, `channel`, `campaign`, `nonTwigLink`, and the raw `data` map.
`TwigLinks.instance.firstSession` returns the install's link data at any later time.

A complete example lives in `sdk/flutter/twig_links/example` (Android intent filters, iOS
entitlements and URL scheme already configured with placeholder domains).

## 3. Native iOS (Swift)

Swift Package Manager: *File → Add Package Dependencies…* → this repository URL, product
`TwigLinks`. CocoaPods: `pod 'TwigLinks', :git => 'https://github.com/your-org/twig.git'`.

```swift
import TwigLinks

// AppDelegate
func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    Twig.shared.start(TwigConfig(
        publicKey: "tw_live_…",
        apiURL: URL(string: "https://links-admin.example.com")!,
        linkDomains: ["links.example.com", "open.example.com"],
        checkPasteboardOnInstall: true
    ), launchOptions: launchOptions)
    Twig.shared.onSession { session in
        guard session.clickedLink, let path = session.deeplinkPath else { return }
        Router.shared.open(path)
    }
    return true
}

// SceneDelegate
func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    connectionOptions.urlContexts.forEach { Twig.shared.handle(url: $0.url) }
    connectionOptions.userActivities.forEach { Twig.shared.handle(userActivity: $0) }
}
func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    URLContexts.forEach { Twig.shared.handle(url: $0.url) }
}
func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    Twig.shared.handle(userActivity: userActivity)
}

// SwiftUI
WindowGroup { ContentView() }
    .onOpenURL { Twig.shared.handle(url: $0) }
    .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { Twig.shared.handle(userActivity: $0) }

// share, events, identity
let url = await Twig.shared.createLink(TwigLinkOptions(data: ["$deeplink_path": "product/42"], channel: "sms"))
try await Twig.shared.logEvent("PURCHASE", revenue: 49.5, currency: "USD")
try await Twig.shared.setIdentity("user-42")
```

## 4. Native Android (Kotlin)

Include `sdk/android/twig-links` as a module (`settings.gradle`: `include(":twig-links")` with
`project(":twig-links").projectDir = file("…/sdk/android/twig-links")`), or publish it with
`./gradlew :twig-links:publishToMavenLocal` and depend on `dev.twig:twig-links:0.1.0`.

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Twig.init(this, TwigConfig(
            publicKey = "tw_live_…",
            apiUrl = "https://links-admin.example.com",
            linkDomains = listOf("links.example.com", "open.example.com"),
        ))
        Twig.addSessionListener { session ->
            if (session.clickedLink) session.deeplinkPath?.let(Router::open)
        }
    }
}

class MainActivity : AppCompatActivity() {
    // Launch intents are captured automatically; forward later ones (singleTop / singleTask).
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        Twig.handleIntent(intent)
    }
}

Twig.createLink(TwigLinkOptions(data = mapOf("\$deeplink_path" to "product/42"), channel = "sms")) { url -> share(url) }
Twig.logEvent("PURCHASE", revenue = 49.5, currency = "USD")
Twig.setIdentity("user-42")
```

The Google Play install referrer is read automatically on the first launch.

## 5. Websites

```html
<script src="https://links-admin.example.com/sdk/twig.js" defer></script>
<script>
  addEventListener('DOMContentLoaded', function () {
    Twig.init('tw_live_…').then(function (session) {
      if (session.data['+clicked_link']) showWelcome(session.data);   // arrived from a Twig link
    });
    // Smart banner on mobile web (settings in Dashboard → Settings → Smart banner)
    Twig.banner({ data: { $deeplink_path: 'product/42', product_id: '42' } });
  });
</script>
```

`Twig.link({...})`, `Twig.logEvent(name, {revenue, currency, data})`, `Twig.setIdentity(id)`,
`Twig.qrCodeUrl(url)` and `Twig.data()` are also available.

Desktop and `$web_only` redirects append `?_twig_match_id=…`; `Twig.init` claims that click and
removes the parameter from the address bar.

### Using your existing website domain for Universal Links

If links must look like `https://www.example.com/products/42`, host the association files on
that domain (copy them from **Domains → Association files**, or proxy `/.well-known/*` to Twig)
and add the domain to the app's entitlements and intent filters. The SDK reports such opens as
`+non_twig_link`; parse the path in your app. Twig short links keep working alongside.

## 6. Server API (create links from your backend)

```bash
curl -X POST https://links-admin.example.com/api/apps/<app_id>/links \
  -H 'Authorization: Bearer tw_secret_…' -H 'Content-Type: application/json' \
  -d '{"alias": "launch", "data": {"$deeplink_path": "promo/launch", "$og_title": "We launched!"}, "channel": "email", "campaign": "launch"}'
```

| Method | Path | Purpose |
|--------|------|---------|
| GET / POST | `/api/apps/:id/links` | list (search, limit, offset) / create |
| POST | `/api/apps/:id/links/bulk` | create up to 500 links in one transaction |
| GET / PATCH / DELETE | `/api/apps/:id/links/:code` | read / update (`data`, tags, `disabled`) / delete |
| GET | `/api/apps/:id/links/:code/stats?days=` | funnel, routes, daily series |
| GET | `/api/apps/:id/analytics/summary\|timeseries\|top-links\|breakdown?by=channel&kind=install` | analytics |
| GET | `/api/apps/:id/export/events.csv?days=` | raw event export |
| GET / POST / PATCH / DELETE | `/api/apps/:id/webhooks[/:wid]` | webhooks |

### Webhook verification (Node example)

```js
const [t, v1] = req.headers['x-twig-signature'].split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) return res.status(401).end();
```

## 7. Testing a link end to end

1. Create a link in the dashboard.
2. Uninstall the app, tap the link on the phone (paste it into Notes / Messages — typing it in the address bar does not trigger Universal Links).
3. Follow the store redirect, then install a build that points at your server (TestFlight / internal testing, or run from Xcode / Android Studio).
4. Open the app: the first session should report `+clicked_link: true` with the link data.
5. Check the link's **How clicks were routed** table and the Overview activity.
