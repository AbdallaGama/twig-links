import 'package:flutter/services.dart';

/// The thin native layer: link capture, device facts, install referrer, pasteboard, storage.
/// Everything else (matching, retries, link creation) lives in Dart.
abstract class TwigNative {
  /// The URL that launched the app (cold start), or null.
  Future<String?> getInitialLink();

  /// URLs that open the already-running app.
  Stream<String> get links;

  Future<Map<String, Object?>> getDeviceInfo();

  /// Android only: raw Google Play install referrer, e.g. `link_click_id=...`.
  Future<String?> getInstallReferrer();

  /// iOS only: a URL on the pasteboard (may show the system paste prompt).
  Future<String?> readPasteboard();

  Future<Map<String, String>> readStorage();

  /// Null values delete keys.
  Future<void> writeStorage(Map<String, String?> values);
}

class MethodChannelTwigNative implements TwigNative {
  static const MethodChannel _channel = MethodChannel('twig_links');
  static const EventChannel _events = EventChannel('twig_links/links');

  Stream<String>? _links;

  @override
  Future<String?> getInitialLink() => _channel.invokeMethod<String>('getInitialLink');

  @override
  Stream<String> get links => _links ??= _events.receiveBroadcastStream().map((event) => event as String);

  @override
  Future<Map<String, Object?>> getDeviceInfo() async =>
      (await _channel.invokeMapMethod<String, Object?>('getDeviceInfo')) ?? const {};

  @override
  Future<String?> getInstallReferrer() => _channel.invokeMethod<String>('getInstallReferrer');

  @override
  Future<String?> readPasteboard() => _channel.invokeMethod<String>('readPasteboard');

  @override
  Future<Map<String, String>> readStorage() async =>
      (await _channel.invokeMapMethod<String, String>('readStorage')) ?? <String, String>{};

  @override
  Future<void> writeStorage(Map<String, String?> values) => _channel.invokeMethod<void>('writeStorage', values);
}
