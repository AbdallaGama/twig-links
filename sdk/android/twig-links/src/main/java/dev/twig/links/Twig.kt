package dev.twig.links

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors

/**
 * Entry point of the Twig Android SDK.
 *
 * ```kotlin
 * // Application.onCreate
 * Twig.init(this, TwigConfig(publicKey = "tw_live_…", apiUrl = "https://links.example.com",
 *                            linkDomains = listOf("links.example.com", "open.example.com")))
 * Twig.addSessionListener { session ->
 *     if (session.clickedLink) session.deeplinkPath?.let(router::open)
 * }
 * // Activity with launchMode="singleTop"/"singleTask"
 * override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); Twig.handleIntent(intent) }
 * ```
 * Launch intents are captured automatically; only `onNewIntent` needs forwarding.
 */
object Twig {
    private const val HANDLED_EXTRA = "dev.twig.links.handled"
    private const val INITIAL_GRACE_MS = 500L
    private const val RESUME_DELAY_MS = 800L
    private const val FOREGROUND_THROTTLE_MS = 30_000L

    private val main = Handler(Looper.getMainLooper())
    private var engine: TwigEngine? = null
    private var appContext: Context? = null
    private var initialOpenSent = false
    private var startedActivities = 0
    private var initialRunnable: Runnable? = null
    private var resumeRunnable: Runnable? = null
    private var trackForeground = true

    /** Starts the SDK. Call once from `Application.onCreate` (main thread). */
    @JvmStatic
    fun init(context: Context, config: TwigConfig) {
        if (engine != null) return
        val app = context.applicationContext
        appContext = app
        val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "twig").apply { isDaemon = true } }
        engine = TwigEngine(config, HttpTransport(), SharedPreferencesStorage(app), DeviceInfo.collect(app), executor, { main.post(it) })
        trackForeground = config.trackForegroundOpens
        (app as? Application)?.registerActivityLifecycleCallbacks(lifecycle)
        // Wait briefly for the launch intent of the first activity; otherwise open without a link.
        initialRunnable = Runnable { sendInitialOpen(null) }.also { main.postDelayed(it, INITIAL_GRACE_MS) }
    }

    /**
     * Reports an intent that may carry a link (App Link, URI scheme). Launch intents are captured
     * automatically; call this from `onNewIntent`. Returns true if the intent had a URL.
     */
    @JvmStatic
    fun handleIntent(intent: Intent?): Boolean {
        val url = linkFrom(intent) ?: return false
        intent?.putExtra(HANDLED_EXTRA, true)
        handleUrl(url)
        return true
    }

    /** Reports a URL received elsewhere (push payload, in-app QR scanner, ...). */
    @JvmStatic
    fun handleUrl(url: String) {
        val engine = requireEngine()
        initialRunnable?.let(main::removeCallbacks)
        resumeRunnable?.let(main::removeCallbacks)
        if (!initialOpenSent) sendInitialOpen(url) else engine.open(url, firstLaunch = false)
    }

    /** Registers a listener (main thread). The latest session, if any, is replayed. Returns an unsubscribe function. */
    @JvmStatic
    fun addSessionListener(listener: (TwigSession) -> Unit): () -> Unit = requireEngine().addListener(listener)

    @JvmStatic
    val latestSession: TwigSession? get() = engine?.latestSession

    /** Link data of the open that installed the app. */
    @JvmStatic
    val firstSession: TwigSession? get() = engine?.firstSession

    @JvmStatic
    fun createLink(options: TwigLinkOptions, callback: (String) -> Unit) = requireEngine().createLink(options, callback)

    @JvmStatic
    fun longLink(options: TwigLinkOptions): String = requireEngine().longLink(options)

    /** Logs a standard (`PURCHASE`, `ADD_TO_CART`, …) or custom event attributed to the last link touch. */
    @JvmStatic
    @JvmOverloads
    fun logEvent(
        name: String,
        revenue: Double? = null,
        currency: String? = null,
        data: Map<String, Any?> = emptyMap(),
        contentItems: List<Map<String, Any?>> = emptyList(),
        callback: ((Throwable?) -> Unit)? = null,
    ) = requireEngine().logEvent(name, revenue, currency, data, contentItems, callback)

    @JvmStatic
    @JvmOverloads
    fun setIdentity(identity: String, callback: ((Throwable?) -> Unit)? = null) = requireEngine().setIdentity(identity, callback)

    @JvmStatic
    @JvmOverloads
    fun logout(callback: ((Throwable?) -> Unit)? = null) = requireEngine().setIdentity(null, callback)

    @JvmStatic
    fun qrCodeUrl(link: String, format: String = "png"): String = requireEngine().qrCodeUrl(link, format)

    @JvmStatic
    fun isTwigLink(url: String): Boolean = requireEngine().isTwigLink(url)

    private fun sendInitialOpen(url: String?) {
        if (initialOpenSent) return
        initialOpenSent = true
        val engine = requireEngine()
        val context = appContext
        val first = engine.isFirstLaunch
        engine.open(url, first, installReferrer = context?.let { { DeviceInfo.installReferrer(it) } })
    }

    private fun linkFrom(intent: Intent?): String? {
        if (intent == null || intent.action != Intent.ACTION_VIEW) return null
        if (intent.getBooleanExtra(HANDLED_EXTRA, false)) return null
        // Relaunching from Recents re-delivers the original intent; it is not a new click.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
        return intent.dataString
    }

    private fun requireEngine(): TwigEngine = engine ?: throw TwigException("not_initialized", "Call Twig.init() first")

    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            if (savedInstanceState == null) handleIntent(activity.intent)
        }

        override fun onActivityStarted(activity: Activity) {
            startedActivities++
            if (startedActivities != 1 || !initialOpenSent) return
            val engine = engine ?: return
            if (!trackForeground) return
            // Coming back to the foreground. A link that caused it arrives via onNewIntent right after.
            resumeRunnable?.let(main::removeCallbacks)
            resumeRunnable = Runnable {
                if (System.currentTimeMillis() - engine.lastOpenAt >= FOREGROUND_THROTTLE_MS) engine.open(null, firstLaunch = false)
            }.also { main.postDelayed(it, RESUME_DELAY_MS) }
        }

        override fun onActivityStopped(activity: Activity) {
            startedActivities = maxOf(0, startedActivities - 1)
        }

        override fun onActivityResumed(activity: Activity) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

}
