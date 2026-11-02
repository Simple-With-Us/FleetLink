import XCTest
final class PortalUITests: XCTestCase {
    func testPopulatedScopesVisibleSortAndPermissions() {
        let app = XCUIApplication(); app.launch()
        let sort = app.buttons["links.sort"]
        XCTAssertTrue(sort.waitForExistence(timeout: 10))
        XCTAssertTrue(sort.staticTexts["Sort"].exists, "Sort text must be visible, not only an icon")
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["alpha"].waitForExistence(timeout: 5))
        app.swipeDown(); sort.tap(); app.buttons["Name"].tap()
        XCTAssertEqual(sort.value as? String, "Name")
        app.buttons["links.scope"].tap(); app.buttons["My teams"].tap()
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["team-view"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Delete team-view"].exists)
        XCTAssertFalse(app.buttons["More options for team-view"].exists)
        XCTAssertTrue(app.buttons["More options for team-edit"].exists)
        app.buttons["More options for team-edit"].tap()
        XCTAssertTrue(app.buttons["Extend Expiry…"].exists)
        XCTAssertFalse(app.buttons["Rename"].exists)
        XCTAssertFalse(app.buttons["Share & Access…"].exists)
        app.tap(); app.swipeDown()
        app.buttons["links.scope"].tap(); app.buttons["My bots"].tap(); app.swipeUp()
        XCTAssertTrue(app.staticTexts["managed-bot"].waitForExistence(timeout: 5))
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.lifetime = .keepAlways; add(attachment)
    }
    func testNativeActivityInputs() {
        let app = XCUIApplication(); app.launchArguments = ["share-inputs"]; app.launch()
        XCTAssertTrue(app.buttons["Share Photo"].waitForExistence(timeout: 5))
        app.buttons["Share Photo"].tap()
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
        // Actual extension selection/auth/provider inspection is run by the
        // runtime operator after installing the signed/qualified main app.
    }
}
