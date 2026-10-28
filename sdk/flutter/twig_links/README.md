# twig_links

Flutter SDK for **Twig**, the free self-hosted deep linking server in this repository:
Universal Links, Android App Links, URI schemes, deferred deep linking (Play install referrer,
iOS pasteboard, fingerprint), short links, events and identity.

* Dart core (sessions, retries, offline long links) + thin native layer (link capture from both
  the app-delegate and UIScene lifecycles on iOS, intents and the install referrer on Android).
* No Dart package dependencies. Requires Flutter 3.38+.

```dart
await TwigLinks.instance.init(TwigConfig(
  publicKey: 'tw_live_…',
  apiUrl: Uri.parse('https://links-admin.example.com'),
  linkDomains: const ['links.example.com', 'open.example.com'],
));
TwigLinks.instance.sessions.listen((session) {
  if (session.clickedLink) router.go('/${session.deeplinkPath}');
});
```

Full setup (entitlements, intent filters, link creation, events): see
[docs/03-integration-guide.md](../../../docs/03-integration-guide.md). A configured example app
is in `example/`.
