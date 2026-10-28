# Twig — free, self-hosted deep linking

Twig is our own replacement for Branch.io: Universal Links, Android App Links, deferred deep
linking, short links, QR codes, smart banners, attribution, analytics and webhooks — running on
**Cloudflare's free plan** (Workers + D1, no credit card), with **no per-user fees** for us or our
customers.

```
repo/
├── server/                 Link server + API + dashboard (TypeScript; Cloudflare Workers + D1, or Node 22)
├── sdk/flutter/twig_links  Flutter plugin (Dart core + Kotlin/Swift capture layer)
├── sdk/ios/TwigLinks       Native iOS SDK (Swift Package / CocoaPods)
├── sdk/android             Native Android SDK (Kotlin library / AAR)
├── sdk/web/twig.js         Web SDK + smart banner (served by the server at /sdk/twig.js)
└── docs/                   Reverse-engineering report, architecture, integration and deployment guides
```

## Deploy to Cloudflare (free)

```bash
cd server && npm install && npx wrangler login && npx wrangler d1 create twig
```

Paste the database id into `server/wrangler.toml`, then:

```bash
cd server && npm run cf:deploy
```

Link domains are free Worker hostnames: `twig.<account>.workers.dev` (primary) and
`twig-alt.<account>.workers.dev` (alternate). See [docs/04-deployment.md](docs/04-deployment.md).

## Run locally

```bash
cd server && npm run dev
```

Open http://localhost:8080/dashboard, create the owner with the setup token printed in the log
(or set `ADMIN_EMAIL` / `ADMIN_PASSWORD`), create an app, add its link domain, fill in the iOS
and Android details, and integrate an SDK from the app's **Integrate** tab.

## Install the SDKs

| Platform | How |
|----------|-----|
| Flutter | `flutter pub add twig_links` (or a git dependency on `sdk/flutter/twig_links`) |
| iOS (Swift) | Swift Package Manager: this repository's URL, version `0.1.0`, product `TwigLinks` — or CocoaPods `pod 'TwigLinks', :git => '…', :tag => '0.1.0'` |
| Android (Kotlin) | Include `sdk/android/twig-links` as a module, or `./gradlew :twig-links:publishToMavenLocal` |
| Web | `<script src="https://<your-worker>/sdk/twig.js">` |

## How a click is routed

| Client | Twig does |
|--------|-----------|
| App installed, Universal Link / App Link honoured | OS opens the app directly; the SDK reports the URL and gets the link data |
| Crawler (iMessage, WhatsApp, Slack, Facebook, X…) | Open Graph + App Links preview page, no click recorded |
| iOS Safari / in-app browsers | Interstitial that copies the link (with its click id) to the pasteboard, then hops to the alternate domain → App Store |
| Android Chrome | `intent://` with the URI scheme or App Link, fallback Play Store with `referrer=link_click_id=…` |
| Android in-app browsers | Interstitial with "Open in app" / "Get the app" |
| Desktop | `$desktop_url` → app desktop URL → QR landing page |
| `$web_only=true` | Always the web (also excluded from the AASA) |

After install, the SDK's first `/v1/open` is matched by click id → Play install referrer →
pasteboard → IP/OS/model fingerprint (in that order of certainty).
See [docs/01-reverse-engineering-report.md](docs/01-reverse-engineering-report.md) for the analysis
this design is based on.

## Tests

```bash
cd server && npm test && npm run typecheck                       # 45 server tests
cd sdk/flutter/twig_links && flutter test && flutter analyze     # 10 Flutter tests
swift test                                                       # 7 iOS SDK tests (repo root)
cd sdk/android && ./gradlew :twig-links:testDebugUnitTest        # 8 Android SDK tests
```

## Documentation

1. [Reverse-engineering report](docs/01-reverse-engineering-report.md) — how Branch.io works, with evidence
2. [Architecture](docs/02-architecture.md) — components, data model, wire protocol, matching
3. [Integration guide](docs/03-integration-guide.md) — Flutter, iOS, Android, Web, server API
4. [Deployment](docs/04-deployment.md) — Cloudflare Workers free plan, D1, limits, domains

Licensed under MIT.
