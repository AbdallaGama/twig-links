import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'models.dart';

/// Sends a JSON POST and returns the decoded JSON object.
typedef TwigTransport = Future<Map<String, Object?>> Function(Uri url, Map<String, Object?> body, Duration timeout);

/// Default transport built on `dart:io` so the plugin has no HTTP dependency.
Future<Map<String, Object?>> httpTransport(Uri url, Map<String, Object?> body, Duration timeout) async {
  final client = HttpClient()..connectionTimeout = timeout;
  try {
    final request = await client.postUrl(url).timeout(timeout);
    request.headers.contentType = ContentType.json;
    request.add(utf8.encode(jsonEncode(body)));
    final response = await request.close().timeout(timeout);
    final text = await response.transform(utf8.decoder).join().timeout(timeout);
    final decoded = text.isEmpty ? <String, Object?>{} : jsonDecode(text);
    final json = decoded is Map ? decoded.cast<String, Object?>() : <String, Object?>{};
    if (response.statusCode >= 400) {
      throw TwigException(json['error'] as String? ?? 'http_${response.statusCode}', json['message'] as String?);
    }
    return json;
  } finally {
    client.close(force: true);
  }
}

/// Retries transient failures (network errors, 5xx, 429) with backoff; client errors are final.
Future<Map<String, Object?>> withRetry(
  TwigTransport transport,
  Uri url,
  Map<String, Object?> body,
  Duration timeout, {
  int retries = 2,
  Duration Function(int attempt)? delay,
}) async {
  for (var attempt = 0;; attempt++) {
    try {
      return await transport(url, body, timeout);
    } on TwigException catch (error) {
      final transient = error.code == 'rate_limited' || error.code.startsWith('http_5') || error.code == 'internal_error';
      if (!transient || attempt >= retries) rethrow;
    } catch (_) {
      if (attempt >= retries) rethrow;
    }
    await Future<void>.delayed((delay ?? (a) => Duration(milliseconds: 500 * (1 << a)))(attempt));
  }
}
