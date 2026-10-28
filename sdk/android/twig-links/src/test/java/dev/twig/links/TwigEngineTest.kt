package dev.twig.links

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.URI

class TwigEngineTest {
    private class MemoryStorage : TwigStorage {
        val values = mutableMapOf<String, String>()
        override fun get(key: String) = values[key]
        override fun set(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private data class Call(val url: String, val body: Map<String, Any?>)

    private val config = TwigConfig(
        publicKey = "tw_live_test",
        apiUrl = "https://api.shop.test/",
        linkDomains = listOf("links.shop.test", "open.shop.test"),
    )
    private lateinit var calls: MutableList<Call>
    private lateinit var storage: MemoryStorage
    private var responder: (Call) -> Map<String, Any?> = { emptyMap() }

    private fun engine() = TwigEngine(
        config = config,
        transport = { url, body, _ -> Call(url, body).also { calls += it }.let(responder) },
        storage = storage,
        device = mapOf("os" to "Android", "os_version" to "15", "model" to "Pixel 9", "hardware_id" to "hw-1"),
        executor = { it.run() },
        post = { it.run() },
        sleep = {},
    )

    @Before
    fun setUp() {
        calls = mutableListOf()
        storage = MemoryStorage()
        responder = { call ->
            mapOf(
                "session_id" to "se_1",
                "device_token" to "dv_1",
                "data" to mapOf("+clicked_link" to true, "+is_first_session" to call.body["is_first_launch"], "\$deeplink_path" to "product/42", "~channel" to "whatsapp"),
            )
        }
    }

    @Test
    fun firstLaunchSendsReferrerAndPersistsState() {
        val engine = engine()
        val sessions = mutableListOf<TwigSession>()
        engine.addListener { sessions += it }
        assertTrue(engine.isFirstLaunch)
        engine.open("https://links.shop.test/AbC", firstLaunch = true) { "link_click_id=1730000000000123456" }

        val call = calls.single()
        assertEquals("https://api.shop.test/v1/open", call.url)
        assertEquals(true, call.body["is_first_launch"])
        assertEquals("https://links.shop.test/AbC", call.body["link_url"])
        assertEquals("link_click_id=1730000000000123456", call.body["install_referrer"])
        assertEquals("android/$TWIG_SDK_VERSION", call.body["sdk"])
        assertEquals("Pixel 9", call.body["model"])
        assertTrue(sessions.single().clickedLink)
        assertEquals("product/42", sessions.single().deeplinkPath)
        assertEquals("whatsapp", sessions.single().channel)
        assertFalse(engine.isFirstLaunch)
        assertEquals("dv_1", storage.values["twig_device_token"])
        assertEquals("product/42", engine.firstSession?.deeplinkPath)
    }

    @Test
    fun laterOpensSendTokenAndSkipReferrer() {
        storage.values["twig_installed"] = "true"
        storage.values["twig_device_token"] = "dv_9"
        var referrerRead = false
        engine().open("shop://product/7?link_click_id=1", firstLaunch = false) { referrerRead = true; "x" }
        assertEquals("dv_9", calls.single().body["device_token"])
        assertFalse(calls.single().body.containsKey("install_referrer"))
        assertFalse(referrerRead)
    }

    @Test
    fun listenersReceiveTheLatestSessionOnSubscribe() {
        val engine = engine()
        engine.open(null, firstLaunch = false)
        var replayed: TwigSession? = null
        val unsubscribe = engine.addListener { replayed = it }
        assertNotNull(replayed)
        unsubscribe()
    }

    @Test
    fun offlineOpenParsesLongLinksAndRetriesTransientErrors() {
        responder = { throw TwigException("http_503") }
        val engine = engine()
        var session: TwigSession? = null
        engine.addListener { session = it }
        engine.open("https://links.shop.test/?\$deeplink_path=cart&coupon=X%201&link_click_id=5", firstLaunch = false)
        assertEquals(3, calls.size)
        assertNotNull(session!!.error)
        assertTrue(session!!.clickedLink)
        assertEquals("X 1", session!!["coupon"])
        assertNull(session!!["link_click_id"])
        assertEquals("cart", session!!.deeplinkPath)
    }

    @Test
    fun clientErrorsAreNotRetried() {
        responder = { throw TwigException("invalid_key") }
        var error: Throwable? = null
        engine().logEvent("PURCHASE", 9.99, "USD", mapOf("sku" to "A1"), emptyList()) { error = it }
        assertEquals(1, calls.size)
        assertTrue(error is TwigException)
        assertEquals(9.99, calls.single().body["revenue"])
    }

    @Test
    fun createLinkFallsBackToLongLink() {
        val engine = engine()
        responder = { mapOf("url" to "https://links.shop.test/Short1") }
        val options = TwigLinkOptions(data = mapOf("\$deeplink_path" to "product/42", "id" to 42, "note" to "a b+c"), channel = "sms", tags = listOf("a", "b"))
        var url = ""
        engine.createLink(options) { url = it }
        assertEquals("https://links.shop.test/Short1", url)
        assertEquals("sms", calls.last().body["channel"])

        responder = { throw TwigException("http_500") }
        engine.createLink(options) { url = it }
        val uri = URI(url)
        assertEquals("links.shop.test", uri.host)
        val query = uri.rawQuery.split('&').associate { it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        assertEquals("product/42", query["%24deeplink_path"])
        assertEquals("42", query["id"])
        assertEquals("a b+c", query["note"])
        assertEquals("a,b", query["%7Etags"])
    }

    @Test
    fun identityIsStoredAndSentAfterTheFirstOpen() {
        val engine = engine()
        engine.setIdentity("early", null)
        assertTrue(calls.isEmpty())
        engine.open(null, firstLaunch = true)
        assertEquals("early", calls.last().body["identity"])
        responder = { mapOf("ok" to true) }
        engine.setIdentity(null, null)
        assertEquals("/v1/identity", URI(calls.last().url).path)
        assertTrue(calls.last().body.containsKey("identity"))
        assertNull(calls.last().body["identity"])
        assertNull(storage.values["twig_identity"])
    }

    @Test
    fun recognisesLinksAndBuildsQrUrls() {
        val engine = engine()
        assertTrue(engine.isTwigLink("https://OPEN.shop.test/x"))
        assertFalse(engine.isTwigLink("https://evil.test/x"))
        assertEquals(
            "https://api.shop.test/v1/qr?url=https%3A%2F%2Flinks.shop.test%2FAbC&format=svg&scale=8",
            engine.qrCodeUrl("https://links.shop.test/AbC", "svg"),
        )
        assertEquals(mapOf("+clicked_link" to false, "+non_twig_link" to "https://evil.test/x"), engine.offlineData("https://evil.test/x"))
    }
}
