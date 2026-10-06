import SwiftUI

@main
struct FleetLinkApp: App {
    @StateObject private var loader = ArtifactLoader()
    @StateObject private var portalManager = PortalManager()
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
                    Label("Portal", systemImage: "chart.bar.xaxis")
                }
                .tag(0)

                // Tab 1: Make Slug / Upload
                CreateSlugView(portalManager: portalManager) { targetURL in
                    inputURLString = targetURL.absoluteString
                    selectedTab = 2
                    Task {
                        await loader.load(url: targetURL)
                    }
                }
                .tabItem {
                    Label("Make Slug", systemImage: "plus.circle.fill")
                }
                .tag(1)

                // Tab 2: Artifact Viewer
                NavigationStack {
                    VStack(spacing: 0) {
                        // Quick input bar
                        HStack(spacing: 8) {
                            Image(systemName: "link")
                                .foregroundColor(.secondary)
                            TextField("Paste fleetlink.online URL...", text: $inputURLString)
                                .textFieldStyle(.plain)
                                .font(.subheadline)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                            Button("Load") {
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
                    .navigationTitle("Artifact Viewer")
                    .navigationBarTitleDisplayMode(.inline)
                }
                .tabItem {
                    Label("Viewer", systemImage: "doc.text.magnifyingglass")
                }
                .tag(2)

                // Tab 3: Settings & Info
                SettingsView()
                    .tabItem {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .tag(3)
            }
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
