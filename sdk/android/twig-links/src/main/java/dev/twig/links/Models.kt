package dev.twig.links

/** Configuration passed to [Twig.init]. */
data class TwigConfig(
    /** The app's public SDK key (`tw_live_...`) from the Twig dashboard. */
    val publicKey: String,
    /** Base URL of your Twig server, e.g. `https://links.example.com`. */
    val apiUrl: String,
    /** Link domains of this app, primary first. */
    val linkDomains: List<String>,
    /** Report an open each time the app returns to the foreground (throttled to 30 s). */
    val trackForegroundOpens: Boolean = true,
    val requestTimeoutMs: Int = 10_000,
    val debug: Boolean = false,
)

/** The result of an app open: link data plus `+` system flags. */
data class TwigSession(
    /** Custom keys, `$` control keys, `~` analytics tags and `+` system flags. */
    val data: Map<String, Any?>,
    val sessionId: String? = null,
    /** The URL that opened the app, if any. */
    val openedUrl: String? = null,
    /** Set when the server was unreachable; [data] then holds what could be parsed locally. */
    val error: Throwable? = null,
) {
    val clickedLink: Boolean get() = data["+clicked_link"] == true
    val isFirstSession: Boolean get() = data["+is_first_session"] == true
    val matchGuaranteed: Boolean get() = data["+match_guaranteed"] == true
    val matchType: String? get() = data["+match_type"] as? String
    /** In-app route for this link (`$deeplink_path`), e.g. `product/42`. */
    val deeplinkPath: String? get() = data["\$deeplink_path"] as? String
    val referringLink: String? get() = data["~referring_link"] as? String
    val channel: String? get() = data["~channel"] as? String
    val feature: String? get() = data["~feature"] as? String
    val campaign: String? get() = data["~campaign"] as? String
    /** The app was opened by a URL that is not a Twig link (e.g. your website). */
    val nonTwigLink: String? get() = data["+non_twig_link"] as? String

    operator fun get(key: String): Any? = data[key]
}

/** Parameters for [Twig.createLink]. */
data class TwigLinkOptions(
    val data: Map<String, Any?> = emptyMap(),
    val alias: String? = null,
    val channel: String? = null,
    val feature: String? = null,
    val campaign: String? = null,
    val stage: String? = null,
    val tags: List<String> = emptyList(),
) {
    internal fun toMap(): Map<String, Any?> = buildMap {
        put("data", data)
        alias?.let { put("alias", it) }
        channel?.let { put("channel", it) }
        feature?.let { put("feature", it) }
        campaign?.let { put("campaign", it) }
        stage?.let { put("stage", it) }
        if (tags.isNotEmpty()) put("tags", tags)
    }
}

class TwigException(val code: String, message: String? = null) : Exception(message ?: code) {
    internal val isTransient: Boolean get() = code == "rate_limited" || code == "internal_error" || code.startsWith("http_5")
}
