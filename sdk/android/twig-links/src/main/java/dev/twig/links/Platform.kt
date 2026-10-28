package dev.twig.links

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Sends a JSON POST and returns the decoded JSON object (blocking; called off the main thread). */
fun interface TwigTransport {
    fun post(url: String, body: Map<String, Any?>, timeoutMs: Int): Map<String, Any?>
}

class HttpTransport : TwigTransport {
    override fun post(url: String, body: Map<String, Any?>, timeoutMs: Int): Map<String, Any?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(Json.encode(body).toByteArray()) }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = if (text.isBlank()) emptyMap() else Json.decodeObject(text)
            if (status >= 400) throw TwigException(json["error"] as? String ?: "http_$status", json["message"] as? String)
            return json
        } finally {
            connection.disconnect()
        }
    }
}

/** Retries network failures and transient server errors with exponential backoff. */
internal fun <T> withRetry(retries: Int = 2, baseDelayMs: Long = 500, sleep: (Long) -> Unit = Thread::sleep, block: () -> T): T {
    var attempt = 0
    while (true) {
        try {
            return block()
        } catch (error: TwigException) {
            if (!error.isTransient || attempt >= retries) throw error
        } catch (error: Exception) {
            if (attempt >= retries) throw error
        }
        sleep(baseDelayMs shl attempt)
        attempt++
    }
}

/** Key-value persistence for SDK state. */
interface TwigStorage {
    fun get(key: String): String?
    fun set(key: String, value: String?)
}

class SharedPreferencesStorage(context: Context) : TwigStorage {
    private val prefs = context.getSharedPreferences("dev.twig.links", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun set(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

internal object Json {
    fun encode(value: Map<String, Any?>): String = toJson(value).toString()

    fun encodeValue(value: Any?): String = toJson(value).toString()

    fun decodeObject(text: String): Map<String, Any?> = fromJson(JSONObject(text)) as Map<String, Any?>

    private fun toJson(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().apply { value.forEach { (k, v) -> put(k.toString(), toJson(v)) } }
        is Iterable<*> -> JSONArray().apply { value.forEach { put(toJson(it)) } }
        is Array<*> -> JSONArray().apply { value.forEach { put(toJson(it)) } }
        is Boolean, is Number, is String -> value
        else -> value.toString()
    }

    private fun fromJson(value: Any?): Any? = when (value) {
        JSONObject.NULL, null -> null
        is JSONObject -> value.keys().asSequence().associateWith { fromJson(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { fromJson(value.get(it)) }
        else -> value
    }
}

internal object DeviceInfo {
    @SuppressLint("HardwareIds")
    fun collect(context: Context): Map<String, Any?> {
        val metrics = context.resources.displayMetrics
        val packageInfo = runCatching {
            if (Build.VERSION.SDK_INT >= 33) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
        }.getOrNull()
        return mapOf(
            "os" to "Android",
            "os_version" to Build.VERSION.RELEASE,
            "model" to Build.MODEL,
            "brand" to Build.MANUFACTURER,
            // ANDROID_ID is scoped to the signing key and survives reinstalls: used to detect reinstalls.
            "hardware_id" to Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID),
            "app_version" to packageInfo?.versionName,
            "first_install_time" to packageInfo?.firstInstallTime,
            "last_update_time" to packageInfo?.lastUpdateTime,
            "locale" to Locale.getDefault().toLanguageTag(),
            "screen_width" to metrics.widthPixels,
            "screen_height" to metrics.heightPixels,
        )
    }

    /** Raw Google Play install referrer, e.g. `link_click_id=...&utm_source=...` (blocking, ≤ 5 s). */
    fun installReferrer(context: Context): String? {
        val client = runCatching { InstallReferrerClient.newBuilder(context).build() }.getOrNull() ?: return null
        val latch = CountDownLatch(1)
        var referrer: String? = null
        try {
            client.startConnection(object : InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(responseCode: Int) {
                    if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                        referrer = runCatching { client.installReferrer.installReferrer }.getOrNull()
                    }
                    latch.countDown()
                }

                override fun onInstallReferrerServiceDisconnected() = latch.countDown()
            })
            latch.await(5, TimeUnit.SECONDS)
        } catch (_: Throwable) {
            // Play services missing (emulators, other stores): no referrer.
        } finally {
            runCatching { client.endConnection() }
        }
        return referrer
    }
}
