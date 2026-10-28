import Foundation

/// Configuration passed to `Twig.shared.start(_:)`.
public struct TwigConfig {
    /// The app's public SDK key (`tw_live_...`) from the Twig dashboard.
    public var publicKey: String
    /// Base URL of your Twig server, e.g. `https://links.example.com`.
    public var apiURL: URL
    /// Link domains of this app, primary first (used to recognise links and build offline long links).
    public var linkDomains: [String]
    /// On the first launch after install, read a Twig link copied to the pasteboard by the
    /// interstitial page. iOS shows the "Allow Paste" prompt, so enable only if it fits your UX.
    public var checkPasteboardOnInstall: Bool
    /// Report an open each time the app returns to the foreground (throttled to 30 s).
    public var trackForegroundOpens: Bool
    public var requestTimeout: TimeInterval
    public var debug: Bool

    public init(
        publicKey: String,
        apiURL: URL,
        linkDomains: [String],
        checkPasteboardOnInstall: Bool = false,
        trackForegroundOpens: Bool = true,
        requestTimeout: TimeInterval = 10,
        debug: Bool = false
    ) {
        self.publicKey = publicKey
        self.apiURL = apiURL
        self.linkDomains = linkDomains
        self.checkPasteboardOnInstall = checkPasteboardOnInstall
        self.trackForegroundOpens = trackForegroundOpens
        self.requestTimeout = requestTimeout
        self.debug = debug
    }
}

/// The result of an app open: link data plus `+` system flags.
public struct TwigSession {
    /// Custom keys, `$` control keys, `~` analytics tags and `+` system flags.
    public let data: [String: Any]
    public let sessionID: String?
    /// The URL that opened the app, if any.
    public let openedURL: URL?
    /// Set when the server was unreachable; `data` then holds what could be parsed locally.
    public let error: Error?

    public init(data: [String: Any], sessionID: String? = nil, openedURL: URL? = nil, error: Error? = nil) {
        self.data = data
        self.sessionID = sessionID
        self.openedURL = openedURL
        self.error = error
    }

    public var clickedLink: Bool { data["+clicked_link"] as? Bool ?? false }
    public var isFirstSession: Bool { data["+is_first_session"] as? Bool ?? false }
    public var matchGuaranteed: Bool { data["+match_guaranteed"] as? Bool ?? false }
    public var matchType: String? { data["+match_type"] as? String }
    /// In-app route for this link (`$deeplink_path`), e.g. `product/42`.
    public var deeplinkPath: String? { data["$deeplink_path"] as? String }
    public var referringLink: String? { data["~referring_link"] as? String }
    public var channel: String? { data["~channel"] as? String }
    public var feature: String? { data["~feature"] as? String }
    public var campaign: String? { data["~campaign"] as? String }
    /// The app was opened by a URL that is not a Twig link (e.g. your website).
    public var nonTwigLink: String? { data["+non_twig_link"] as? String }

    public subscript(key: String) -> Any? { data[key] }
}

/// Parameters for `Twig.shared.createLink(_:)`.
public struct TwigLinkOptions {
    public var data: [String: Any]
    public var alias: String?
    public var channel: String?
    public var feature: String?
    public var campaign: String?
    public var stage: String?
    public var tags: [String]

    public init(data: [String: Any] = [:], alias: String? = nil, channel: String? = nil, feature: String? = nil, campaign: String? = nil, stage: String? = nil, tags: [String] = []) {
        self.data = data
        self.alias = alias
        self.channel = channel
        self.feature = feature
        self.campaign = campaign
        self.stage = stage
        self.tags = tags
    }

    var json: [String: Any] {
        var out: [String: Any] = ["data": data]
        out["alias"] = alias
        out["channel"] = channel
        out["feature"] = feature
        out["campaign"] = campaign
        out["stage"] = stage
        if !tags.isEmpty { out["tags"] = tags }
        return out
    }
}

public struct TwigError: Error, CustomStringConvertible {
    public let code: String
    public let message: String?

    public init(_ code: String, _ message: String? = nil) {
        self.code = code
        self.message = message
    }

    public var description: String { "TwigError(\(code)\(message.map { ": \($0)" } ?? ""))" }

    var isTransient: Bool { code == "rate_limited" || code == "internal_error" || code.hasPrefix("http_5") }
}
