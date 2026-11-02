import XCTest
@testable import FleetLink

private final class StubProtocol: URLProtocol {
    static var reply: ((URLRequest) -> (Int, Data, TimeInterval))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, data, delay) = Self.reply(request)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

@MainActor
final class PortalManagerTests: XCTestCase {
    private func manager() -> PortalManager {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return PortalManager(urlSession: URLSession(configuration: config))
    }
    private func page(_ slugs: [String], next: String? = nil, permissions: Bool = true) -> Data {
        let shares: [[String: Any]] = slugs.map { slug in
            var row: [String: Any] = ["slug": slug, "url": "https://fleetlink.online/\(slug)", "kind": "files", "has_password": false, "file_count": 1, "total_bytes": 12, "renewals": 0, "created_at": "2026-11-01T12:00:00Z"]
            if permissions { row["can_manage"] = false; row["can_edit"] = true }
            return row
        }
        return try! JSONSerialization.data(withJSONObject: ["shares": shares, "next": next as Any? ?? NSNull()])
    }
    func testPagesDeduplicateAndKeepScopeAndBearer() async {
        let model = manager(); model.scope = .teams
        let first = page(["one"], next: "cursor"); let last = page(["one", "two"])
        var requests: [URLRequest] = []
        StubProtocol.reply = { request in
            requests.append(request)
            return (200, request.url!.query!.contains("before=cursor") ? last : first, 0)
        }
        await model.fetchShares(host: "https://fixture.invalid", token: "test-only")
        XCTAssertEqual(model.shares.map(\.slug), ["one", "two"])
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0.url!.query!.contains("scope=teams") && $0.value(forHTTPHeaderField: "Authorization") == "Bearer test-only" })
        XCTAssertEqual(model.shares.first?.can_edit, true)
        XCTAssertEqual(model.shares.first?.can_manage, false)
    }
    func testMissingPermissionsFailClosed() async {
        let model = manager(); let data = page(["view-only"], permissions: false)
        StubProtocol.reply = { _ in (200, data, 0) }
        await model.fetchShares(token: "test-only")
        XCTAssertEqual(model.shares.first?.can_edit, false)
        XCTAssertEqual(model.shares.first?.can_manage, false)
    }
    func testCacheRetainedOnTransientErrorButClearedOnAuthAndScopeChange() async {
        let model = manager(); let data = page(["cached"])
        StubProtocol.reply = { _ in (200, data, 0) }; await model.fetchShares(token: "one")
        StubProtocol.reply = { _ in (503, Data(), 0) }; await model.fetchShares(token: "one")
        XCTAssertEqual(model.shares.map(\.slug), ["cached"])
        model.scope = .bots; await model.fetchShares(token: "one"); XCTAssertTrue(model.shares.isEmpty)
        StubProtocol.reply = { _ in (200, data, 0) }; await model.fetchShares(token: "one")
        StubProtocol.reply = { _ in (401, Data(), 0) }; await model.fetchShares(token: "one")
        XCTAssertTrue(model.shares.isEmpty); XCTAssertNotNil(model.errorMessage)
    }
    func testChangedAccountClearsCachedRowsOnFailure() async {
        let model = manager(); let data = page(["private"])
        StubProtocol.reply = { _ in (200, data, 0) }; await model.fetchShares(token: "one")
        StubProtocol.reply = { _ in (503, Data(), 0) }; await model.fetchShares(token: "two")
        XCTAssertTrue(model.shares.isEmpty)
    }
    func testLateOldScopeCannotOverwriteNewScope() async {
        let model = manager(); let old = page(["old"]); let new = page(["new"])
        StubProtocol.reply = { req in req.url!.query!.contains("scope=mine") ? (200, old, 0.15) : (200, new, 0) }
        let pending = Task { await model.fetchShares(token: "one") }
        try? await Task.sleep(nanoseconds: 30_000_000)
        model.scope = .teams; await model.fetchShares(token: "one"); await pending.value
        XCTAssertEqual(model.shares.map(\.slug), ["new"])
        XCTAssertFalse(model.isLoading)
    }
    func testRepeatedCursorAndUniqueCursorLimitNeverPublishPartialRows() async {
        let model = manager(); let repeated = page(["partial"], next: "same")
        StubProtocol.reply = { _ in (200, repeated, 0) }; await model.fetchShares(token: "one")
        XCTAssertTrue(model.shares.isEmpty); XCTAssertTrue(model.errorMessage?.contains("repeated") == true)
        var count = 0
        let pages = (1...100).map { page(["partial"], next: "\($0)") }
        StubProtocol.reply = { _ in let data = pages[count]; count += 1; return (200, data, 0) }
        await model.fetchShares(token: "one")
        XCTAssertEqual(count, 100); XCTAssertTrue(model.shares.isEmpty)
        XCTAssertTrue(model.errorMessage?.contains("web dashboard") == true)
    }
}
