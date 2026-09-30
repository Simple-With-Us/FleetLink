import SwiftUI

@main
struct FleetLinkApp: App {
    @StateObject private var loader = ArtifactLoader()
    @State private var inputURLString = "https://fleetlink.online"
    @State private var selectedTab = 0

    var body: some Scene {
        WindowGroup {
            TabView(selection: $selectedTab) {
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
                        .padding()

                        Divider()

                        ArtifactContainerView(loader: loader, isClip: false)
                    }
                    .navigationTitle("FleetLink")
                    .navigationBarTitleDisplayMode(.inline)
                }
                .tabItem {
                    Label("Artifact", systemImage: "doc.text.magnifyingglass")
                }
                .tag(0)

                NavigationStack {
                    List {
                        Section("Recent Links") {
                            Button("https://fleetlink.online") {
                                inputURLString = "https://fleetlink.online"
                                selectedTab = 0
                                if let url = URL(string: inputURLString) {
                                    Task { await loader.load(url: url) }
                                }
                            }
                        }

                        Section("Supported Domains") {
                            HStack {
                                Text("fleetlink.online")
                                Spacer()
                                Text("Default")
                                    .font(.caption.bold())
                                    .foregroundColor(.green)
                            }
                            HStack {
                                Text("fleetlink.app")
                                Spacer()
                                Text("Secondary")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        }

                        Section("Features") {
                            Label("App Clip Quick Preview", systemImage: "bolt.badge.automatic.fill")
                            Label("Universal Links", systemImage: "arrow.up.right.square")
                            Label("Multi-file Batch Shares", systemImage: "folder")
                            Label("Automatic Expiration", systemImage: "clock")
                        }
                    }
                    .navigationTitle("Settings & Info")
                }
                .tabItem {
                    Label("Info", systemImage: "info.circle")
                }
                .tag(1)
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { userActivity in
                guard let incomingURL = userActivity.webpageURL else { return }
                inputURLString = incomingURL.absoluteString
                selectedTab = 0
                Task {
                    await loader.load(url: incomingURL)
                }
            }
            .onOpenURL { url in
                inputURLString = url.absoluteString
                selectedTab = 0
                Task {
                    await loader.load(url: url)
                }
            }
            .task {
                if case .idle = loader.state {
                    if let defaultURL = URL(string: "https://fleetlink.online") {
                        await loader.load(url: defaultURL)
                    }
                }
            }
        }
    }
}
