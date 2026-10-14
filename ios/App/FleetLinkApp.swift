import SwiftUI

@main
struct FleetLinkApp: App {
    init() {
        SentryTelemetry.start(surface: "ios-app")
    }

    @StateObject private var loader = ArtifactLoader()
    @StateObject private var portalManager = PortalManager()
    @StateObject private var session = SessionManager()
    @State private var inputURLString = "https://fleetlink.online"
    @State private var selectedTab = 0

    var body: some Scene {
        WindowGroup {
            TabView(selection: $selectedTab) {
                // Tab 0: Portal & Analytics
                PortalView(portalManager: portalManager) { targetURL in
                    inputURLString = targetURL.absoluteString
                    selectedTab = 2
                    Task {
                        await loader.load(url: targetURL)
                    }
                }
                .tabItem {
                    Label("Links", systemImage: "link")
                }
                .tag(0)

                // Tab 1: New link
                CreateSlugView(portalManager: portalManager) { targetURL in
                    inputURLString = targetURL.absoluteString
                    selectedTab = 2
                    Task {
                        await loader.load(url: targetURL)
                    }
                }
                .tabItem {
                    Label("New link", systemImage: "plus.circle.fill")
                }
                .tag(1)

                // Tab 2: View
                NavigationStack {
                    VStack(spacing: 0) {
                        // Quick input bar
                        HStack(spacing: 8) {
                            Image(systemName: "link")
                                .foregroundColor(.secondary)
                            TextField("Paste a fleetlink.online link", text: $inputURLString)
                                .textFieldStyle(.plain)
                                .font(.body)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .accessibilityLabel("Link address")
                            Button("Open") {
                                if let url = URL(string: inputURLString.trimmingCharacters(in: .whitespacesAndNewlines)) {
                                    Task { await loader.load(url: url) }
                                }
                            }
                            .font(.caption.bold())
                            .buttonStyle(.borderedProminent)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(UIColor.secondarySystemGroupedBackground))
                        .cornerRadius(10)
                        .padding([.horizontal, .top])

                        Divider()
                            .padding(.top, 8)

                        ArtifactContainerView(loader: loader, isClip: false)
                    }
                    .navigationTitle("View")
                    .navigationBarTitleDisplayMode(.inline)
                }
                .tabItem {
                    Label("View", systemImage: "doc.text.magnifyingglass")
                }
                .tag(2)

                // Tab 3: Settings & Info
                SettingsView(session: session)
                    .tabItem {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .tag(3)
            }
            .environmentObject(session)
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { userActivity in
                guard let incomingURL = userActivity.webpageURL else { return }
                inputURLString = incomingURL.absoluteString
                selectedTab = 2
                Task {
                    await loader.load(url: incomingURL)
                }
            }
            .onOpenURL { url in
                inputURLString = url.absoluteString
                selectedTab = 2
                Task {
                    await loader.load(url: url)
                }
            }
        }
    }
}
