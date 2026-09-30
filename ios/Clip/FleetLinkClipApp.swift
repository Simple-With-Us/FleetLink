import SwiftUI

@main
struct FleetLinkClipApp: App {
    @StateObject private var loader = ArtifactLoader()

    var body: some Scene {
        WindowGroup {
            ArtifactContainerView(loader: loader, isClip: true)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { userActivity in
                    guard let incomingURL = userActivity.webpageURL else { return }
                    Task {
                        await loader.load(url: incomingURL)
                    }
                }
                .onOpenURL { url in
                    Task {
                        await loader.load(url: url)
                    }
                }
                .task {
                    // If launched without an invocation URL in simulator testing
                    if case .idle = loader.state {
                        if let defaultURL = URL(string: "https://fleetlink.online") {
                            await loader.load(url: defaultURL)
                        }
                    }
                }
        }
    }
}
