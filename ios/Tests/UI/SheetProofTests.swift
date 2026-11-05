import XCTest

// Drives the harness's real UIActivityViewController and asserts the FleetLink
// share extension is selectable in the actual system sheet and that its
// ShareViewController loads for each input type (FL-80).
// Needs the harness app launched with the `share-inputs` argument.
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
        while Date() < deadline {
            for query in [app.buttons, app.cells, app.staticTexts, app.otherElements] as [XCUIElementQuery] {
                let el = query["FleetLink"]
                // Only a hittable element can be tapped; returning a
                // non-hittable match masks a missing/offscreen activity as a
                // "failed to synthesize event" tap error, so keep polling.
                if el.exists && el.isHittable { return el }
            }
            // Keep scrolling for the whole timeout: a three-swipe budget is
            // consumed in the first seconds and then deeper activities are
            // falsely reported absent from a static list.
            let cv = app.collectionViews.firstMatch
            if cv.exists && cv.isHittable && !cv.frame.isEmpty {
                cv.swipeLeft()
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
        XCTAssertTrue(
            main.wait(for: .runningForeground, timeout: 15),
            "Fixture seeding requires the FleetLink app and extension built and installed in Debug with -DFLEETLINK_SHARE_FIXTURE; the FleetLinkQualification scheme installs only FleetLinkHarness, so install the app before running this class."
        )
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
        // The placeholder "Preparing preview…" exists before the extension
        // resolves; wait for a resolved label so the signed-out gate
        // assertion below is meaningful instead of passing on the placeholder.
        let previewResolved = NSPredicate(format: "label != %@", "Preparing preview…")
        let resolution = XCTNSPredicateExpectation(predicate: previewResolved, object: preview)
        XCTAssertEqual(XCTWaiter.wait(for: [resolution], timeout: 20), .completed, "preview never resolved: \(preview.label)")
        XCTAssertFalse(preview.label.contains("sign in"), "unexpected signed-out gate: \(preview.label)")
        shoot("fixture-personal-preview")

        // The team flow is the point of this fixture test: missing controls
        // must fail loudly, not silently continue on Personal where Create
        // link is enabled and the example.invalid assertion would still pass.
        let teamSegment = app.buttons["Team"]
        XCTAssertTrue(teamSegment.waitForExistence(timeout: 5), "Team segment missing; the fixture team flow cannot run on Personal")
        teamSegment.tap()
        let choose = app.buttons["Choose team"]
        XCTAssertTrue(choose.waitForExistence(timeout: 10), "Choose team button missing; the fixture team flow cannot run on Personal")
        choose.tap()
        let fixtureTeam = app.buttons["Fixture Team"]
        XCTAssertTrue(fixtureTeam.waitForExistence(timeout: 6), "Fixture Team not listed")
        fixtureTeam.tap()
        shoot("fixture-team-selected")

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
