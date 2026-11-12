import XCTest

// Jay's qualification-only proof (own copy fl80-sheetproof, not source-owned):
// drives the harness's real UIActivityViewController and asserts the FleetLink
// share extension is selectable in the actual system sheet and that its
// ShareViewController loads for each input type.
final class SheetProofTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func findFleetLink(in app: XCUIApplication, timeout: TimeInterval = 10) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        var swipes = 0
        while Date() < deadline {
            for query in [app.buttons, app.cells, app.staticTexts, app.otherElements] as [XCUIElementQuery] {
                let el = query["FleetLink"]
                if el.exists && el.isHittable { return el }
                if el.exists { return el }
            }
            if swipes < 3 {
                let cv = app.collectionViews.firstMatch
                if cv.exists && cv.isHittable && !cv.frame.isEmpty {
                    cv.swipeLeft()
                    swipes += 1
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        }
        return nil
    }

    private func prove(button: String, tag: String) {
        let app = XCUIApplication()
        app.launchArguments = ["share-inputs"]
        app.launch()
        let trigger = app.buttons[button]
        XCTAssertTrue(trigger.waitForExistence(timeout: 10), "harness button \(button) missing")
        trigger.tap()
        guard let fl = findFleetLink(in: app, timeout: 30) else {
            shoot("sheet-\(tag)-nofleetlink")
            XCTFail("FleetLink activity not found in the share sheet for \(tag)")
            return
        }
        shoot("sheet-\(tag)-fleetlink-visible")
        fl.tap()
        let preview = app.staticTexts["share.preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 20), "ShareViewController preview did not load for \(tag)")
        shoot("extension-\(tag)-loaded")
        let cancel = app.buttons["Cancel"]
        if cancel.waitForExistence(timeout: 3) { cancel.tap() }
        app.terminate()
    }

    func testSheetPhoto() { prove(button: "Share Photo", tag: "photo") }
    func testSheetFile() { prove(button: "Share File", tag: "file") }
    func testSheetText() { prove(button: "Share Text", tag: "text") }
    func testSheetURL() { prove(button: "Share URL", tag: "url") }
}



final class SheetProofAuthedTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    // Requires a Debug + FLEETLINK_SHARE_FIXTURE build of app+extension.
    // Seeds ONLY the synthetic fixture credential via the main app's own
    // production ShareSession.save path (--seed-share-fixture). The extension
    // is then fail-closed to synthetic responses - no URLSession, no upload.
    func testSheetPhotoFixturePreviewCreateCopy() {
        let main = XCUIApplication(bundleIdentifier: "online.fleetlink.ios")
        main.launchArguments = ["--seed-share-fixture"]
        main.launch()
        sleep(3)
        main.terminate()

        let app = XCUIApplication()
        app.launchArguments = ["share-inputs"]
        app.launch()
        let trigger = app.buttons["Share Photo"]
        XCTAssertTrue(trigger.waitForExistence(timeout: 10))
        trigger.tap()
        let helper = SheetProofTests()
        guard let fl = helper.findFleetLink(in: app, timeout: 30) else {
            shoot("fixture-sheet-nofleetlink")
            print("SHEET-DEBUG buttons: \(app.buttons.allElementsBoundByIndex.map { $0.label })")
            print("SHEET-DEBUG cells: \(app.cells.allElementsBoundByIndex.map { $0.label })")
            XCTFail("FleetLink activity not found (fixture)")
            return
        }
        fl.tap()
        let preview = app.staticTexts["share.preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 20))
        XCTAssertFalse(preview.label.contains("sign in"), "unexpected signed-out gate: \(preview.label)")
        shoot("fixture-personal-preview")

        let teamSegment = app.buttons["Team"]
        if teamSegment.waitForExistence(timeout: 5) { teamSegment.tap() }
        let choose = app.buttons["Choose team"]
        if choose.waitForExistence(timeout: 10) {
            choose.tap()
            let fixtureTeam = app.buttons["Fixture Team"]
            if fixtureTeam.waitForExistence(timeout: 6) {
                fixtureTeam.tap()
                shoot("fixture-team-selected")
            } else {
                shoot("fixture-team-missing")
                XCTFail("Fixture Team not listed")
            }
        }

        let create = app.buttons["Create link"]
        XCTAssertTrue(create.waitForExistence(timeout: 6))
        XCTAssertTrue(create.isEnabled, "Create link disabled: \(preview.label)")
        create.tap()
        let copyLink = app.buttons["Copy link"]
        XCTAssertTrue(copyLink.waitForExistence(timeout: 20), "no Copy link UI: \(preview.label)")
        XCTAssertTrue(preview.label.contains("example.invalid"), "result not the fixture link: \(preview.label)")
        shoot("fixture-create-result-copy-ui")
        let cancel = app.buttons["Cancel"]
        if cancel.waitForExistence(timeout: 3) { cancel.tap() }
        app.terminate()
    }
}
