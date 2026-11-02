import XCTest
@testable import FleetLink
final class ShareSessionTests: XCTestCase {
    func testHostAllowlistRejectsCredentialsPortsPathsAndLookalikes() {
        for value in ["http://fleetlink.online", "https://fleetlink.online.attacker.invalid", "https://user@fleetlink.online", "https://fleetlink.online:444", "https://fleetlink.online/path", "https://fleetlink.app?token=x"] {
            XCTAssertNil(ShareSession.allowedOrigin(value))
        }
        XCTAssertEqual(ShareSession.allowedOrigin("https://fleetlink.app/")?.absoluteString, "https://fleetlink.app")
        XCTAssertEqual(ShareSession.allowedOrigin("https://fleetlink.online")?.absoluteString, "https://fleetlink.online")
    }
}
