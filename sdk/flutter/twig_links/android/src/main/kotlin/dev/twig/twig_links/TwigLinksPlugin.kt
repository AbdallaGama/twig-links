package dev.twig.twig_links

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native half of the Twig Flutter SDK on Android: captures App Links / URI scheme intents,
 * reads the Play install referrer and device facts, and stores SDK state.
 */
class TwigLinksPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, EventChannel.StreamHandler,
    ActivityAware, PluginRegistry.NewIntentListener {

    private lateinit var channel: MethodChannel
    private lateinit var events: EventChannel
    private lateinit var context: Context
    private var activityBinding: ActivityPluginBinding? = null
    private var sink: EventChannel.EventSink? = null
    private val pending = mutableListOf<String>()
    private var initialLink: String? = null
    private var initialCaptured = false
    private val main = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "twig_links")
        channel.setMethodCallHandler(this)
        events = EventChannel(binding.binaryMessenger, "twig_links/links")
        events.setStreamHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        events.setStreamHandler(null)
    }

    // ---------------------------------------------------------------- activity + intents

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activityBinding = binding
        binding.addOnNewIntentListener(this)
        if (!initialCaptured) {
            initialCaptured = true
            initialLink = linkFrom(binding.activity.intent)
        }
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activityBinding = binding
        binding.addOnNewIntentListener(this)
    }

    override fun onDetachedFromActivity() {
        activityBinding?.removeOnNewIntentListener(this)
        activityBinding = null
    }

    override fun onNewIntent(intent: Intent): Boolean {
        linkFrom(intent)?.let(::emit)
        return false // let other plugins see the intent too
    }

    private fun linkFrom(intent: Intent?): String? {
        if (intent == null || intent.action != Intent.ACTION_VIEW) return null
        // Relaunching from Recents re-delivers the original intent; it is not a new click.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
        return intent.dataString
    }

    private fun emit(link: String) {
        val current = sink
        if (current == null) pending.add(link) else current.success(link)
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        sink = events
        pending.forEach(events::success)
        pending.clear()
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    // ---------------------------------------------------------------- method channel

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getInitialLink" -> result.success(initialLink)
            "getDeviceInfo" -> result.success(deviceInfo())
            "getInstallReferrer" -> readInstallReferrer(result)
            "readPasteboard" -> result.success(null)
            "readStorage" -> result.success(prefs().all.mapValues { it.value?.toString() }.filterValues { it != null })
            "writeStorage" -> {
                val values = call.arguments as? Map<*, *> ?: emptyMap<Any, Any>()
                val editor = prefs().edit()
                values.forEach { (key, value) ->
                    if (value == null) editor.remove(key.toString()) else editor.putString(key.toString(), value.toString())
                }
                editor.apply()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun prefs() = context.getSharedPreferences("twig_links", Context.MODE_PRIVATE)

    @SuppressLint("HardwareIds")
    private fun deviceInfo(): Map<String, Any?> {
        val metrics = context.resources.displayMetrics
        val packageInfo = try {
            if (Build.VERSION.SDK_INT >= 33) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
        } catch (_: Exception) {
            null
        }
        return mapOf(
            "os" to "Android",
            "os_version" to Build.VERSION.RELEASE,
            "model" to Build.MODEL,
            "brand" to Build.MANUFACTURER,
            // ANDROID_ID is scoped to the app signing key and survives reinstalls: used to detect reinstalls.
            "hardware_id" to Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID),
            "app_version" to packageInfo?.versionName,
            "first_install_time" to packageInfo?.firstInstallTime,
            "last_update_time" to packageInfo?.lastUpdateTime,
            "locale" to Locale.getDefault().toLanguageTag(),
            "screen_width" to metrics.widthPixels,
            "screen_height" to metrics.heightPixels,
        )
    }

    private fun readInstallReferrer(result: MethodChannel.Result) {
        val answered = AtomicBoolean(false)
        val reply: (String?) -> Unit = { value -> if (answered.compareAndSet(false, true)) main.post { result.success(value) } }
        val client = try {
            InstallReferrerClient.newBuilder(context).build()
        } catch (_: Throwable) {
            reply(null)
            return
        }
        main.postDelayed({ reply(null); runCatching { client.endConnection() } }, 5_000)
        try {
            client.startConnection(object : InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(responseCode: Int) {
                    val referrer = if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                        runCatching { client.installReferrer.installReferrer }.getOrNull()
                    } else {
                        null
                    }
                    reply(referrer)
                    runCatching { client.endConnection() }
                }

                override fun onInstallReferrerServiceDisconnected() = reply(null)
            })
        } catch (_: Throwable) {
            reply(null)
        }
    }
}
