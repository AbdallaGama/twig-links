import XCTest
@testable import TwigLinks

final class MemoryStorage: TwigStorage {
    var values: [String: String] = [:]
    func string(_ key: String) -> String? { values[key] }
    func set(_ value: String?, for key: String) { values[key] = value }
}

final class FakeTransport: TwigTransport, @unchecked Sendable {
    var calls: [(url: URL, body: [String: Any])] = []
    var responder: (URL, [String: Any]) throws -> [String: Any] = { _, body in
        ["session_id": "se_1", "device_token": "dv_1",
         "data": ["+clicked_link": true, "+is_first_session": body["is_first_launch"] as? Bool ?? false, "$deeplink_path": "product/42", "~channel": "sms"]]
    }

    func post(_ url: URL, body: [String: Any], timeout: TimeInterval) async throws -> [String: Any] {
        calls.append((url, body))
        return try responder(url, body)
    }
}

final class TwigTests: XCTestCase {
    private let config = TwigConfig(
        publicKey: "tw_live_test",
        apiURL: URL(string: "https://api.shop.test")!,
        linkDomains: ["links.shop.test", "open.shop.test"],
        trackForegroundOpens: false
    )

    private func makeTwig(_ transport: FakeTransport, _ storage: MemoryStorage = MemoryStorage()) -> Twig {
        Twig(transport: transport, storage: storage, deviceInfo: { ["os": "iOS", "os_version": "18.5", "model": "iPhone15,2", "hardware_id": "hw-1"] },
             callbackQueue: DispatchQueue(label: "twig.tests"))
    }

    func testFirstLaunchWithUniversalLinkSendsInstallOpen() async throws {
        let transport = FakeTransport()
        let storage = MemoryStorage()
        let twig = makeTwig(transport, storage)
        let received = expectation(description: "session")
        twig.onSession { session in
            XCTAssertTrue(session.clickedLink)
            XCTAssertEqual(session.deeplinkPath, "product/42")
            XCTAssertEqual(session.channel, "sms")
            received.fulfill()
        }
        twig.start(config, launchURL: URL(string: "https://links.shop.test/AbC")!)
        await fulfillment(of: [received], timeout: 2)
        await twig.flush()

        let call = try XCTUnwrap(transport.calls.first)
        XCTAssertEqual(call.url.absoluteString, "https://api.shop.test/v1/open")
        XCTAssertEqual(call.body["is_first_launch"] as? Bool, true)
        XCTAssertEqual(call.body["link_url"] as? String, "https://links.shop.test/AbC")
        XCTAssertEqual(call.body["key"] as? String, "tw_live_test")
        XCTAssertEqual(call.body["sdk"] as? String, "ios/\(twigSDKVersion)")
        XCTAssertEqual(storage.values["twig_installed"], "true")
        XCTAssertEqual(storage.values["twig_device_token"], "dv_1")
        XCTAssertEqual(twig.firstSession?.deeplinkPath, "product/42")
    }

    func testLinkDeliveredDuringGracePeriodBecomesTheInitialOpen() async throws {
        let transport = FakeTransport()
        let twig = makeTwig(transport)
        twig.start(config, initialLinkGracePeriod: 5)
        XCTAssertTrue(twig.handle(url: URL(string: "https://links.shop.test/AbC")!))
        await twig.flush()
        XCTAssertEqual(transport.calls.count, 1)
        XCTAssertEqual(transport.calls[0].body["is_first_launch"] as? Bool, true)
        XCTAssertEqual(transport.calls[0].body["link_url"] as? String, "https://links.shop.test/AbC")
    }

    func testLaterLinksSendDeviceTokenAndAreNotFirstLaunch() async throws {
        let transport = FakeTransport()
        let storage = MemoryStorage()
        storage.values = ["twig_installed": "true", "twig_device_token": "dv_9"]
        let twig = makeTwig(transport, storage)
        twig.start(config, launchURL: URL(string: "shop://product/7?link_click_id=1730000000000123456")!)
        await twig.flush()
        XCTAssertEqual(transport.calls[0].body["is_first_launch"] as? Bool, false)
        XCTAssertEqual(transport.calls[0].body["device_token"] as? String, "dv_9")
        _ = twig.handle(url: URL(string: "https://open.shop.test/x")!)
        await twig.flush()
        XCTAssertEqual(transport.calls.count, 2)
        XCTAssertEqual(transport.calls[1].body["device_token"] as? String, "dv_1")
    }

    func testOfflineOpenParsesLongLinkAndRetriesTransientErrors() async throws {
        let transport = FakeTransport()
        transport.responder = { _, _ in throw TwigError("http_503") }
        let twig = makeTwig(transport)
        let received = expectation(description: "session")
        twig.onSession { session in
            XCTAssertNotNil(session.error)
            XCTAssertTrue(session.clickedLink)
            XCTAssertEqual(session["coupon"] as? String, "X1")
            XCTAssertNil(session["link_click_id"])
            received.fulfill()
        }
        twig.start(config, launchURL: URL(string: "https://links.shop.test/?$deeplink_path=cart&coupon=X1&link_click_id=5")!)
        await fulfillment(of: [received], timeout: 5)
        XCTAssertEqual(transport.calls.count, 3)
    }

    func testCreateLinkFallsBackToLongLink() async throws {
        let transport = FakeTransport()
        let twig = makeTwig(transport)
        twig.start(config, launchURL: URL(string: "https://links.shop.test/a")!)
        await twig.flush()
        transport.responder = { _, _ in ["url": "https://links.shop.test/Short1"] }
        let options = TwigLinkOptions(data: ["$deeplink_path": "product/42", "price": "1+1"], channel: "sms", tags: ["a", "b"])
        let short = await twig.createLink(options)
        XCTAssertEqual(short, "https://links.shop.test/Short1")
        XCTAssertEqual(transport.calls.last?.body["channel"] as? String, "sms")

        transport.responder = { _, _ in throw TwigError("invalid_key") }
        let long = await twig.createLink(options)
        let components = try XCTUnwrap(URLComponents(string: long))
        XCTAssertEqual(components.host, "links.shop.test")
        XCTAssertEqual(components.queryItems?.first { $0.name == "$deeplink_path" }?.value, "product/42")
        XCTAssertTrue(long.contains("price=1%2B1"))
        XCTAssertEqual(components.queryItems?.first { $0.name == "~tags" }?.value, "a,b")
    }

    func testEventsAndIdentityUseTheStoredDeviceToken() async throws {
        let transport = FakeTransport()
        let storage = MemoryStorage()
        let twig = makeTwig(transport, storage)
        twig.start(config, launchURL: URL(string: "https://links.shop.test/a")!)
        transport.responder = { url, _ in url.path == "/v1/open" ? ["device_token": "dv_1", "data": [:]] : ["ok": true] }
        try await twig.logEvent("PURCHASE", revenue: 9.99, currency: "USD", data: ["sku": "A1"])
        let event = try XCTUnwrap(transport.calls.last)
        XCTAssertEqual(event.url.path, "/v1/event")
        XCTAssertEqual(event.body["device_token"] as? String, "dv_1")
        XCTAssertEqual(event.body["revenue"] as? Double, 9.99)

        try await twig.setIdentity("user-7")
        XCTAssertEqual(transport.calls.last?.body["identity"] as? String, "user-7")
        XCTAssertEqual(storage.values["twig_identity"], "user-7")
        try await twig.logout()
        XCTAssertTrue(transport.calls.last?.body["identity"] is NSNull)
        XCTAssertNil(storage.values["twig_identity"] ?? nil)
    }

    func testQRCodeURLAndLinkRecognition() {
        let twig = makeTwig(FakeTransport())
        twig.start(config, initialLinkGracePeriod: 60)
        XCTAssertEqual(twig.qrCodeURL(for: "https://links.shop.test/AbC", format: "svg")?.absoluteString,
                       "https://api.shop.test/v1/qr?url=https://links.shop.test/AbC&format=svg&scale=8")
        XCTAssertTrue(twig.isTwigLink(URL(string: "https://OPEN.shop.test/x")!))
        XCTAssertFalse(twig.isTwigLink(URL(string: "https://evil.test/x")!))
    }
}
