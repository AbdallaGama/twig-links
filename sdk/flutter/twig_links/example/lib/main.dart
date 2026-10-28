import 'dart:async';

import 'package:flutter/material.dart';
import 'package:twig_links/twig_links.dart';

// Replace with your Twig server, app key and link domains from the dashboard.
final _config = TwigConfig(
  publicKey: 'tw_live_REPLACE_ME',
  apiUrl: Uri.parse('https://links.example.com'),
  linkDomains: const ['links.example.com', 'open.example.com'],
  checkPasteboardOnInstall: true,
  debug: true,
);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  unawaited(TwigLinks.instance.init(_config));
  runApp(const ExampleApp());
}

class ExampleApp extends StatefulWidget {
  const ExampleApp({super.key});

  @override
  State<ExampleApp> createState() => _ExampleAppState();
}

class _ExampleAppState extends State<ExampleApp> {
  final _navigator = GlobalKey<NavigatorState>();
  StreamSubscription<TwigSession>? _subscription;
  TwigSession? _session;
  String? _createdLink;

  @override
  void initState() {
    super.initState();
    _session = TwigLinks.instance.latestSession;
    _subscription = TwigLinks.instance.sessions.listen((session) {
      setState(() => _session = session);
      final path = session.deeplinkPath;
      if (session.clickedLink && path != null) {
        _navigator.currentState?.push(MaterialPageRoute<void>(builder: (_) => _DeepLinkPage(path: path, session: session)));
      }
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  Future<void> _share() async {
    final url = await TwigLinks.instance.createLink(const TwigLinkOptions(
      data: {r'$deeplink_path': 'product/42', r'$og_title': 'Red Shoes', 'product_id': '42'},
      channel: 'in_app_share',
      feature: 'sharing',
    ));
    setState(() => _createdLink = url);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: _navigator,
      home: Scaffold(
        appBar: AppBar(title: const Text('Twig example')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('Latest session', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            SelectableText(_session?.toString() ?? 'waiting…'),
            const SizedBox(height: 24),
            FilledButton(onPressed: _share, child: const Text('Create share link')),
            if (_createdLink != null) ...[
              const SizedBox(height: 8),
              SelectableText(_createdLink!),
            ],
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () => TwigLinks.instance.logEvent('PURCHASE', revenue: 19.99, currency: 'USD', data: {'sku': 'A1'}),
              child: const Text('Log PURCHASE event'),
            ),
          ],
        ),
      ),
    );
  }
}

class _DeepLinkPage extends StatelessWidget {
  const _DeepLinkPage({required this.path, required this.session});

  final String path;
  final TwigSession session;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('/$path')),
        body: Padding(padding: const EdgeInsets.all(16), child: SelectableText(session.data.toString())),
      );
}
