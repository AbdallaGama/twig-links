import Flutter
import UIKit

/// Native half of the Twig Flutter SDK on iOS: captures Universal Links and URI schemes from
/// both the app-delegate and UIScene lifecycles, reads device facts, the pasteboard (opt-in)
/// and stores SDK state.
public final class TwigLinksPlugin: NSObject, FlutterPlugin, FlutterStreamHandler, FlutterSceneLifeCycleDelegate {
  private var sink: FlutterEventSink?
  private var pending: [String] = []
  private var initialLink: String?
  private var initialLinkDelivered = false
  private let defaults = UserDefaults(suiteName: "dev.twig.links") ?? .standard

  public static func register(with registrar: FlutterPluginRegistrar) {
    let instance = TwigLinksPlugin()
    let channel = FlutterMethodChannel(name: "twig_links", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(instance, channel: channel)
    FlutterEventChannel(name: "twig_links/links", binaryMessenger: registrar.messenger()).setStreamHandler(instance)
    registrar.addApplicationDelegate(instance)
    registrar.addSceneDelegate(instance)
  }

  // MARK: - Link capture

  private func record(_ url: URL?) {
    guard let link = url?.absoluteString else { return }
    if !initialLinkDelivered && initialLink == nil {
      initialLink = link
    } else if let sink {
      sink(link)
    } else {
      pending.append(link)
    }
  }

  private func webURL(_ activity: NSUserActivity?) -> URL? {
    guard let activity, activity.activityType == NSUserActivityTypeBrowsingWeb else { return nil }
    return activity.webpageURL
  }

  // App-delegate lifecycle (apps that have not adopted UIScene).
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [AnyHashable: Any] = [:]) -> Bool {
    record(launchOptions[UIApplication.LaunchOptionsKey.url] as? URL)
    if let activities = launchOptions[UIApplication.LaunchOptionsKey.userActivityDictionary] as? [AnyHashable: Any] {
      record(webURL(activities.values.compactMap { $0 as? NSUserActivity }.first))
    }
    return true
  }

  public func application(_ application: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    record(url)
    return false // observe only: other plugins and Flutter's router still receive the URL
  }

  public func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([Any]) -> Void) -> Bool {
    record(webURL(userActivity))
    return false
  }

  // UIScene lifecycle (Flutter 3.38+ default for new apps).
  public func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions?) -> Bool {
    if let options = connectionOptions {
      record(options.urlContexts.first?.url)
      record(webURL(options.userActivities.first { $0.activityType == NSUserActivityTypeBrowsingWeb }))
    }
    return false
  }

  public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) -> Bool {
    URLContexts.forEach { record($0.url) }
    return false
  }

  public func scene(_ scene: UIScene, continue userActivity: NSUserActivity) -> Bool {
    record(webURL(userActivity))
    return false
  }

  // MARK: - FlutterStreamHandler

  public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    sink = events
    pending.forEach { events($0) }
    pending.removeAll()
    return nil
  }

  public func onCancel(withArguments arguments: Any?) -> FlutterError? {
    sink = nil
    return nil
  }

  // MARK: - Method channel

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "getInitialLink":
      initialLinkDelivered = true
      result(initialLink)
    case "getDeviceInfo":
      result(deviceInfo())
    case "getInstallReferrer":
      result(nil)
    case "readPasteboard":
      readPasteboard(result)
    case "readStorage":
      let values = defaults.dictionaryRepresentation().filter { $0.key.hasPrefix("twig_") }.compactMapValues { $0 as? String }
      result(values)
    case "writeStorage":
      (call.arguments as? [String: Any?])?.forEach { key, value in
        if let string = value as? String { defaults.set(string, forKey: key) } else { defaults.removeObject(forKey: key) }
      }
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func deviceInfo() -> [String: Any?] {
    var systemInfo = utsname()
    uname(&systemInfo)
    let machine = withUnsafeBytes(of: &systemInfo.machine) { buffer in
      String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF8.self)
    }
    let screen = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
    let size = screen?.nativeBounds.size
    return [
      "os": "iOS",
      "os_version": UIDevice.current.systemVersion,
      "model": machine,
      "brand": "Apple",
      // identifierForVendor survives app updates; it resets only when all apps of the vendor are removed.
      "hardware_id": UIDevice.current.identifierForVendor?.uuidString,
      "app_version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
      "locale": Locale.preferredLanguages.first ?? Locale.current.identifier,
      "screen_width": size.map { Int($0.width) },
      "screen_height": size.map { Int($0.height) },
    ]
  }

  /// Checks for a web URL without triggering the paste prompt, then reads it (iOS shows
  /// "Allow Paste" once). Called only on the first launch and only if the app opted in.
  private func readPasteboard(_ result: @escaping FlutterResult) {
    let pasteboard = UIPasteboard.general
    pasteboard.detectPatterns(for: [.probableWebURL]) { detection in
      guard case .success(let patterns) = detection, patterns.contains(.probableWebURL) else {
        DispatchQueue.main.async { result(nil) }
        return
      }
      DispatchQueue.main.async { result(pasteboard.url?.absoluteString ?? pasteboard.string) }
    }
  }
}
