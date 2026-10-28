import Foundation
#if canImport(UIKit)
import UIKit
#endif

public let twigSDKVersion = "0.1.0"

/// Entry point of the Twig iOS SDK.
///
/// ```swift
/// // AppDelegate.application(_:didFinishLaunchingWithOptions:)
/// Twig.shared.start(TwigConfig(publicKey: "tw_live_…", apiURL: URL(string: "https://links.example.com")!,
///                              linkDomains: ["links.example.com", "open.example.com"]))
/// Twig.shared.onSession { session in
///     if session.clickedLink, let path = session.deeplinkPath { router.open(path) }
/// }
/// // SceneDelegate / SwiftUI: forward incoming links
/// .onOpenURL { Twig.shared.handle(url: $0) }
/// .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { Twig.shared.handle(userActivity: $0) }
/// ```
public final class Twig: @unchecked Sendable {
    public static let shared = Twig()

    private enum Key {
        static let installed = "twig_installed"
        static let deviceToken = "twig_device_token"
        static let identity = "twig_identity"
        static let firstSession = "twig_first_session"
    }

    private let transport: TwigTransport
    private let storage: TwigStorage
    private let deviceInfo: () -> [String: Any]
    private let lock = NSLock()
    private let callbackQueue: DispatchQueue

    private var config: TwigConfig?
    private var device: [String: Any] = [:]
    private var deviceToken: String?
    private var identity: String?
    private var firstLaunch = false
    private var initialOpenSent = false
    private var initialTimer: DispatchWorkItem?
    private var resumeTimer: DispatchWorkItem?
    private var lastOpen = Date.distantPast
    private var tail: Task<Void, Never>?
    private var observers: [UUID: (TwigSession) -> Void] = [:]
    private var foregroundObserver: NSObjectProtocol?
    public private(set) var latestSession: TwigSession?

    /// For tests: inject network, storage and device facts.
    public init(
        transport: TwigTransport = URLSessionTransport(),
        storage: TwigStorage = UserDefaultsStorage(),
        deviceInfo: (() -> [String: Any])? = nil,
        callbackQueue: DispatchQueue = .main
    ) {
        self.transport = transport
        self.storage = storage
        self.deviceInfo = deviceInfo ?? DeviceInfo.current
        self.callbackQueue = callbackQueue
    }

    // MARK: - Lifecycle

    /// Starts the SDK. Call once from `application(_:didFinishLaunchingWithOptions:)`.
    /// The first open waits briefly for a launch URL delivered through `handle(url:)` /
    /// `handle(userActivity:)` (UIScene apps receive it after launch).
    public func start(_ config: TwigConfig, launchURL: URL? = nil, initialLinkGracePeriod: TimeInterval = 0.5) {
        lock.lock()
        guard self.config == nil else { lock.unlock(); return }
        self.config = config
        device = deviceInfo()
        deviceToken = storage.string(Key.deviceToken)
        identity = storage.string(Key.identity)
        firstLaunch = storage.string(Key.installed) != "true"
        lock.unlock()

        observeForeground(config)
        if let launchURL {
            _ = handle(url: launchURL)
            return
        }
        let work = DispatchWorkItem { [weak self] in self?.sendInitialOpen(linkURL: nil) }
        lock.lock()
        initialTimer = work
        lock.unlock()
        callbackQueue.asyncAfter(deadline: .now() + initialLinkGracePeriod, execute: work)
    }

    #if canImport(UIKit)
    /// Convenience for app-delegate apps: extracts the launch URL or Universal Link.
    public func start(_ config: TwigConfig, launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
        var url = launchOptions?[.url] as? URL
        if url == nil, let activities = launchOptions?[.userActivityDictionary] as? [AnyHashable: Any] {
            url = activities.values.compactMap { $0 as? NSUserActivity }.first { $0.activityType == NSUserActivityTypeBrowsingWeb }?.webpageURL
        }
        start(config, launchURL: url)
    }
    #endif

    /// Forward Universal Links. Returns true when the URL is one of your Twig link domains.
    @discardableResult
    public func handle(userActivity: NSUserActivity) -> Bool {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL else { return false }
        return handle(url: url)
    }

    /// Forward URI-scheme URLs and Universal Links. Returns true for Twig links.
    @discardableResult
    public func handle(url: URL) -> Bool {
        lock.lock()
        let isInitial = !initialOpenSent
        initialTimer?.cancel()
        resumeTimer?.cancel()
        lock.unlock()
        if isInitial {
            sendInitialOpen(linkURL: url)
        } else {
            enqueueOpen(linkURL: url, firstLaunch: false, pasteboardURL: nil)
        }
        return isTwigLink(url) || url.scheme.map { !["http", "https"].contains($0) } == true
    }

    /// Registers a session listener (called on the main queue). The latest session, if any, is replayed.
    @discardableResult
    public func onSession(_ handler: @escaping (TwigSession) -> Void) -> TwigObservation {
        let id = UUID()
        lock.lock()
        observers[id] = handler
        let latest = latestSession
        lock.unlock()
        if let latest { callbackQueue.async { handler(latest) } }
        return TwigObservation { [weak self] in
            self?.lock.lock()
            self?.observers[id] = nil
            self?.lock.unlock()
        }
    }

    /// Link data of the open that installed the app.
    public var firstSession: TwigSession? {
        guard let raw = storage.string(Key.firstSession), let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return TwigSession(data: json)
    }

    public func isTwigLink(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        lock.lock()
        defer { lock.unlock() }
        return config?.linkDomains.contains { $0.lowercased() == host } ?? false
    }

    // MARK: - Opens

    private func sendInitialOpen(linkURL: URL?) {
        lock.lock()
        guard !initialOpenSent, let config else { lock.unlock(); return }
        initialOpenSent = true
        let isFirst = firstLaunch
        lock.unlock()
        let readPasteboard = isFirst && linkURL == nil && config.checkPasteboardOnInstall
        enqueueOpen(linkURL: linkURL, firstLaunch: isFirst, pasteboardURL: nil, readPasteboard: readPasteboard)
    }

    private func enqueueOpen(linkURL: URL?, firstLaunch: Bool, pasteboardURL: String?, readPasteboard: Bool = false) {
        enqueue { [weak self] in
            guard let self else { return }
            var pasteboard = pasteboardURL
            if readPasteboard, let candidate = await Pasteboard.readURL(), let url = URL(string: candidate), self.isTwigLink(url) {
                pasteboard = candidate
            }
            await self.open(linkURL: linkURL, firstLaunch: firstLaunch, pasteboardURL: pasteboard)
        }
    }

    /// Serialises SDK work so each request sees the device token of the previous one.
    private func enqueue(_ work: @escaping () async -> Void) {
        lock.lock()
        let previous = tail
        tail = Task {
            await previous?.value
            await work()
        }
        lock.unlock()
    }

    /// Waits for every queued request; useful in tests and before app termination.
    public func flush() async {
        let current = locked { tail }
        await current?.value
    }

    private func open(linkURL: URL?, firstLaunch: Bool, pasteboardURL: String?) async {
        let prepared: (TwigConfig, [String: Any])? = locked {
            guard let config else { return nil }
            lastOpen = Date()
            var body = device
            body["key"] = config.publicKey
            body["sdk"] = "ios/\(twigSDKVersion)"
            body["is_first_launch"] = firstLaunch
            body["device_token"] = deviceToken
            body["identity"] = identity
            body["link_url"] = linkURL?.absoluteString
            body["pasteboard_url"] = pasteboardURL
            return (config, body)
        }
        guard let (config, body) = prepared else { return }

        let session: TwigSession
        do {
            let json = try await withRetry { try await self.transport.post(self.endpoint(config, "/v1/open"), body: body, timeout: config.requestTimeout) }
            log("open → \(json)")
            let data = json["data"] as? [String: Any] ?? [:]
            let token: String? = locked {
                if let token = json["device_token"] as? String { deviceToken = token }
                return deviceToken
            }
            storage.set("true", for: Key.installed)
            storage.set(token, for: Key.deviceToken)
            if firstLaunch, let encoded = try? JSONSerialization.data(withJSONObject: data) {
                storage.set(String(data: encoded, encoding: .utf8), for: Key.firstSession)
            }
            session = TwigSession(data: data, sessionID: json["session_id"] as? String, openedURL: linkURL)
        } catch {
            log("open failed: \(error)")
            session = TwigSession(data: offlineData(linkURL), openedURL: linkURL, error: error)
        }
        publish(session)
    }

    /// Best-effort data when the server is unreachable: long-link query parameters.
    func offlineData(_ url: URL?) -> [String: Any] {
        guard let url else { return ["+clicked_link": false] }
        guard isTwigLink(url) else { return ["+clicked_link": false, "+non_twig_link": url.absoluteString] }
        var data: [String: Any] = ["+clicked_link": true, "+match_type": "offline", "~referring_link": url.absoluteString]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
            if item.name.hasPrefix("+") || item.name == "link_click_id" || item.name.hasPrefix("_twig") || item.name.hasPrefix("__twig") { continue }
            data[item.name] = item.value ?? ""
        }
        return data
    }

    private func publish(_ session: TwigSession) {
        let handlers = locked {
            latestSession = session
            return Array(observers.values)
        }
        callbackQueue.async { handlers.forEach { $0(session) } }
    }

    private func observeForeground(_ config: TwigConfig) {
        #if canImport(UIKit)
        guard config.trackForegroundOpens else { return }
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            // A link that brought the app forward arrives right after this notification.
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let recent = Date().timeIntervalSince(self.lastOpen) < 30
                self.lock.unlock()
                if !recent { self.enqueueOpen(linkURL: nil, firstLaunch: false, pasteboardURL: nil) }
            }
            self.lock.lock()
            self.resumeTimer?.cancel()
            self.resumeTimer = work
            self.lock.unlock()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
        }
        #endif
    }

    // MARK: - Links, events, identity

    /// Creates a short link; falls back to a long link (no network needed) on failure.
    public func createLink(_ options: TwigLinkOptions) async -> String {
        guard let config = currentConfig() else { return "" }
        var body = options.json
        body["key"] = config.publicKey
        do {
            let json = try await withRetry { try await self.transport.post(self.endpoint(config, "/v1/url"), body: body, timeout: config.requestTimeout) }
            if let url = json["url"] as? String { return url }
        } catch {
            log("createLink failed, using long link: \(error)")
        }
        return longLink(options) ?? ""
    }

    /// A link carrying its data in the query string.
    public func longLink(_ options: TwigLinkOptions) -> String? {
        guard let domain = currentConfig()?.linkDomains.first else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = domain
        components.path = "/"
        var items: [URLQueryItem] = options.data.keys.sorted().compactMap { key in
            guard let value = options.data[key] else { return nil }
            if let string = value as? String { return URLQueryItem(name: key, value: string) }
            if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) {
                return URLQueryItem(name: key, value: String(data: data, encoding: .utf8))
            }
            return URLQueryItem(name: key, value: "\(value)")
        }
        if let channel = options.channel { items.append(URLQueryItem(name: "~channel", value: channel)) }
        if let feature = options.feature { items.append(URLQueryItem(name: "~feature", value: feature)) }
        if let campaign = options.campaign { items.append(URLQueryItem(name: "~campaign", value: campaign)) }
        if let stage = options.stage { items.append(URLQueryItem(name: "~stage", value: stage)) }
        if !options.tags.isEmpty { items.append(URLQueryItem(name: "~tags", value: options.tags.joined(separator: ","))) }
        components.queryItems = items
        // URLComponents leaves "+" unescaped, which servers decode as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url?.absoluteString
    }

    /// Logs a standard (`PURCHASE`, `ADD_TO_CART`, …) or custom event attributed to the last link touch.
    public func logEvent(_ name: String, revenue: Double? = nil, currency: String? = nil, data: [String: Any] = [:], contentItems: [[String: Any]] = []) async throws {
        guard let config = currentConfig() else { throw TwigError("not_initialized") }
        try await runQueued {
            let (os, token) = self.locked { (self.device["os"] ?? "iOS", self.deviceToken) }
            var body: [String: Any] = ["key": config.publicKey, "name": name, "os": os]
            body["device_token"] = token
            body["revenue"] = revenue
            body["currency"] = currency
            if !data.isEmpty { body["data"] = data }
            if !contentItems.isEmpty { body["content_items"] = contentItems }
            _ = try await withRetry { try await self.transport.post(self.endpoint(config, "/v1/event"), body: body, timeout: config.requestTimeout) }
        }
    }

    /// Associates your user id with this device.
    public func setIdentity(_ identity: String) async throws { try await updateIdentity(identity) }

    public func logout() async throws { try await updateIdentity(nil) }

    private func updateIdentity(_ value: String?) async throws {
        guard let config = currentConfig() else { throw TwigError("not_initialized") }
        locked { identity = value }
        storage.set(value, for: Key.identity)
        try await runQueued {
            let token = self.locked { self.deviceToken }
            guard let token else { return } // sent with the next open instead
            var body: [String: Any] = ["key": config.publicKey, "device_token": token]
            body["identity"] = value ?? NSNull()
            _ = try await withRetry { try await self.transport.post(self.endpoint(config, "/v1/identity"), body: body, timeout: config.requestTimeout) }
        }
    }

    /// URL of a QR code image for a link on one of your domains.
    public func qrCodeURL(for link: String, format: String = "png", scale: Int = 8) -> URL? {
        guard let config = currentConfig(), var components = URLComponents(url: endpoint(config, "/v1/qr"), resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [URLQueryItem(name: "url", value: link), URLQueryItem(name: "format", value: format), URLQueryItem(name: "scale", value: String(scale))]
        return components.url
    }

    // MARK: - Helpers

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private func runQueued(_ work: @escaping () async throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            enqueue {
                do {
                    try await work()
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func currentConfig() -> TwigConfig? {
        lock.lock()
        defer { lock.unlock() }
        return config
    }

    private func endpoint(_ config: TwigConfig, _ path: String) -> URL {
        config.apiURL.appendingPathComponent(String(path.dropFirst()))
    }

    private func log(_ message: @autoclosure () -> String) {
        if currentConfig()?.debug == true { print("[twig] \(message())") }
    }
}

/// Returned by `onSession`; call `cancel()` to stop receiving sessions.
public final class TwigObservation {
    private let onCancel: () -> Void

    init(_ onCancel: @escaping () -> Void) {
        self.onCancel = onCancel
    }

    public func cancel() { onCancel() }
}
