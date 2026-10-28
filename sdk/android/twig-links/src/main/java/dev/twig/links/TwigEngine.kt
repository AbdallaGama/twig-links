package dev.twig.links

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.Executor

const val TWIG_SDK_VERSION = "0.1.0"

/**
 * Platform-independent SDK core: request building, serialisation, persistence and offline
 * fallbacks. [Twig] wires it to Android (Context, intents, lifecycle).
 */
class TwigEngine(
    private val config: TwigConfig,
    private val transport: TwigTransport,
    private val storage: TwigStorage,
    private val device: Map<String, Any?>,
    /** Must run tasks one at a time, in order (each request needs the previous device token). */
    private val executor: Executor,
    /** Delivers callbacks, normally on the main thread. */
    private val post: (Runnable) -> Unit,
    private val sleep: (Long) -> Unit = Thread::sleep,
) {
    private object Key {
        const val INSTALLED = "twig_installed"
        const val DEVICE_TOKEN = "twig_device_token"
        const val IDENTITY = "twig_identity"
        const val FIRST_SESSION = "twig_first_session"
    }

    private val lock = Any()
    private val listeners = LinkedHashMap<UUID, (TwigSession) -> Unit>()
    @Volatile private var deviceToken: String? = storage.get(Key.DEVICE_TOKEN)
    @Volatile private var identity: String? = storage.get(Key.IDENTITY)
    @Volatile var latestSession: TwigSession? = null
        private set
    @Volatile var lastOpenAt: Long = 0
        private set

    val isFirstLaunch: Boolean get() = storage.get(Key.INSTALLED) != "true"

    val firstSession: TwigSession?
        get() = storage.get(Key.FIRST_SESSION)?.let { runCatching { TwigSession(Json.decodeObject(it)) }.getOrNull() }

    fun addListener(listener: (TwigSession) -> Unit): () -> Unit {
        val id = UUID.randomUUID()
        val latest = synchronized(lock) {
            listeners[id] = listener
            latestSession
        }
        latest?.let { session -> post(Runnable { listener(session) }) }
        return { synchronized(lock) { listeners.remove(id) } }
    }

    fun isTwigLink(url: String): Boolean {
        val host = runCatching { URI(url).host }.getOrNull()?.lowercase() ?: return false
        return config.linkDomains.any { it.lowercase() == host }
    }

    fun open(linkUrl: String?, firstLaunch: Boolean, installReferrer: (() -> String?)? = null) {
        executor.execute {
            lastOpenAt = System.currentTimeMillis()
            val body = buildMap<String, Any?> {
                putAll(device)
                put("key", config.publicKey)
                put("sdk", "android/$TWIG_SDK_VERSION")
                put("is_first_launch", firstLaunch)
                deviceToken?.let { put("device_token", it) }
                identity?.let { put("identity", it) }
                linkUrl?.let { put("link_url", it) }
                if (firstLaunch) installReferrer?.invoke()?.let { put("install_referrer", it) }
            }
            val session = try {
                val json = withRetry(sleep = sleep) { transport.post(endpoint("/v1/open"), body, config.requestTimeoutMs) }
                log("open → $json")
                (json["device_token"] as? String)?.let { deviceToken = it }
                @Suppress("UNCHECKED_CAST")
                val data = json["data"] as? Map<String, Any?> ?: emptyMap()
                storage.set(Key.INSTALLED, "true")
                storage.set(Key.DEVICE_TOKEN, deviceToken)
                if (firstLaunch) storage.set(Key.FIRST_SESSION, Json.encode(data))
                TwigSession(data, json["session_id"] as? String, linkUrl)
            } catch (error: Exception) {
                log("open failed: $error")
                TwigSession(offlineData(linkUrl), openedUrl = linkUrl, error = error)
            }
            publish(session)
        }
    }

    private fun publish(session: TwigSession) {
        val targets = synchronized(lock) {
            latestSession = session
            listeners.values.toList()
        }
        post(Runnable { targets.forEach { it(session) } })
    }

    /** Best-effort data when offline: long-link query parameters of a Twig URL. */
    fun offlineData(url: String?): Map<String, Any?> {
        if (url == null) return mapOf("+clicked_link" to false)
        if (!isTwigLink(url)) return mapOf("+clicked_link" to false, "+non_twig_link" to url)
        val data = linkedMapOf<String, Any?>()
        val query = runCatching { URI(url).rawQuery }.getOrNull().orEmpty()
        for (pair in query.split('&')) {
            if (pair.isEmpty()) continue
            val key = URLDecoder.decode(pair.substringBefore('='), "UTF-8")
            if (key.startsWith("+") || key == "link_click_id" || key.startsWith("_twig") || key.startsWith("__twig")) continue
            data[key] = URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8")
        }
        return data + mapOf("+clicked_link" to true, "+match_type" to "offline", "~referring_link" to url)
    }

    /** Creates a short link; falls back to a long link (no network needed) on failure. */
    fun createLink(options: TwigLinkOptions, callback: (String) -> Unit) {
        executor.execute {
            val url = try {
                val json = withRetry(sleep = sleep) {
                    transport.post(endpoint("/v1/url"), options.toMap() + ("key" to config.publicKey), config.requestTimeoutMs)
                }
                json["url"] as? String ?: longLink(options)
            } catch (error: Exception) {
                log("createLink failed, using long link: $error")
                longLink(options)
            }
            post(Runnable { callback(url) })
        }
    }

    /** A link carrying its data in the query string. */
    fun longLink(options: TwigLinkOptions): String {
        val domain = config.linkDomains.firstOrNull() ?: throw TwigException("no_link_domain")
        val params = linkedMapOf<String, String>()
        options.data.forEach { (key, value) ->
            if (value != null) params[key] = if (value is String) value else Json.encodeValue(value)
        }
        options.channel?.let { params["~channel"] = it }
        options.feature?.let { params["~feature"] = it }
        options.campaign?.let { params["~campaign"] = it }
        options.stage?.let { params["~stage"] = it }
        if (options.tags.isNotEmpty()) params["~tags"] = options.tags.joinToString(",")
        val query = params.entries.joinToString("&") { (key, value) -> "${encode(key)}=${encode(value)}" }
        return "https://$domain/" + if (query.isEmpty()) "" else "?$query"
    }

    fun logEvent(name: String, revenue: Double?, currency: String?, data: Map<String, Any?>, contentItems: List<Map<String, Any?>>, callback: ((Throwable?) -> Unit)?) {
        executor.execute {
            val body = buildMap<String, Any?> {
                put("key", config.publicKey)
                put("device_token", deviceToken)
                put("name", name)
                put("os", device["os"])
                revenue?.let { put("revenue", it) }
                currency?.let { put("currency", it) }
                if (data.isNotEmpty()) put("data", data)
                if (contentItems.isNotEmpty()) put("content_items", contentItems)
            }
            val error = runCatching { withRetry(sleep = sleep) { transport.post(endpoint("/v1/event"), body, config.requestTimeoutMs) } }.exceptionOrNull()
            if (error != null) log("logEvent failed: $error")
            callback?.let { post(Runnable { it(error) }) }
        }
    }

    fun setIdentity(value: String?, callback: ((Throwable?) -> Unit)?) {
        identity = value
        storage.set(Key.IDENTITY, value)
        executor.execute {
            val token = deviceToken
            val error = if (token == null) null else runCatching {
                withRetry(sleep = sleep) {
                    transport.post(endpoint("/v1/identity"), mapOf("key" to config.publicKey, "device_token" to token, "identity" to value), config.requestTimeoutMs)
                }
            }.exceptionOrNull()
            callback?.let { post(Runnable { it(error) }) }
        }
    }

    fun qrCodeUrl(link: String, format: String = "png", scale: Int = 8): String =
        "${endpoint("/v1/qr")}?url=${encode(link)}&format=${encode(format)}&scale=$scale"

    private fun endpoint(path: String) = config.apiUrl.trimEnd('/') + path

    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun log(message: String) {
        if (config.debug) println("[twig] $message")
    }
}
