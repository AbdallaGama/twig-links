import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Sends a JSON POST and returns the decoded JSON object.
public protocol TwigTransport {
    func post(_ url: URL, body: [String: Any], timeout: TimeInterval) async throws -> [String: Any]
}

public struct URLSessionTransport: TwigTransport {
    public init() {}

    public func post(_ url: URL, body: [String: Any], timeout: TimeInterval) async throws -> [String: Any] {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            throw TwigError(json["error"] as? String ?? "http_\(status)", json["message"] as? String)
        }
        return json
    }
}

/// Retries network errors and transient server errors with exponential backoff.
func withRetry(retries: Int = 2, baseDelay: TimeInterval = 0.5, _ operation: () async throws -> [String: Any]) async throws -> [String: Any] {
    var attempt = 0
    while true {
        do {
            return try await operation()
        } catch let error as TwigError where !error.isTransient {
            throw error
        } catch {
            if attempt >= retries { throw error }
        }
        try? await Task.sleep(nanoseconds: UInt64(baseDelay * pow(2, Double(attempt)) * 1_000_000_000))
        attempt += 1
    }
}

/// Key-value persistence for SDK state.
public protocol TwigStorage {
    func string(_ key: String) -> String?
    func set(_ value: String?, for key: String)
}

public struct UserDefaultsStorage: TwigStorage {
    private let defaults: UserDefaults

    public init(suiteName: String = "dev.twig.links") {
        defaults = UserDefaults(suiteName: suiteName) ?? .standard
    }

    public func string(_ key: String) -> String? { defaults.string(forKey: key) }

    public func set(_ value: String?, for key: String) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

enum DeviceInfo {
    static func current() -> [String: Any] {
        var info: [String: Any] = ["brand": "Apple"]
        var systemInfo = utsname()
        uname(&systemInfo)
        info["model"] = withUnsafeBytes(of: &systemInfo.machine) { buffer in
            String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        info["app_version"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        info["locale"] = Locale.preferredLanguages.first ?? Locale.current.identifier
        #if canImport(UIKit)
        info["os"] = "iOS"
        info["os_version"] = UIDevice.current.systemVersion
        // identifierForVendor survives updates; it resets only when every app of the vendor is removed.
        info["hardware_id"] = UIDevice.current.identifierForVendor?.uuidString
        if let screen = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.screen }).first {
            info["screen_width"] = Int(screen.nativeBounds.width)
            info["screen_height"] = Int(screen.nativeBounds.height)
        }
        #else
        info["os"] = "macOS"
        info["os_version"] = ProcessInfo.processInfo.operatingSystemVersionString
        #endif
        return info
    }
}

enum Pasteboard {
    /// Checks for a web URL without the paste prompt, then reads it (iOS asks the user once).
    static func readURL() async -> String? {
        #if canImport(UIKit)
        let pasteboard = UIPasteboard.general
        let hasURL: Bool = await withCheckedContinuation { continuation in
            pasteboard.detectPatterns(for: [.probableWebURL]) { result in
                if case .success(let patterns) = result {
                    continuation.resume(returning: patterns.contains(.probableWebURL))
                } else {
                    continuation.resume(returning: false)
                }
            }
        }
        guard hasURL else { return nil }
        return await MainActor.run { pasteboard.url?.absoluteString ?? pasteboard.string }
        #else
        return nil
        #endif
    }
}
