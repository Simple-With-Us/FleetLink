import SwiftUI

public struct SettingsView: View {
    @ObservedObject var session: SessionManager
    @ObservedObject private var passkeys: PasskeyCoordinator

    @AppStorage("fleetlink_server_host") private var serverHost: String = "https://fleetlink.online"

    public init(session: SessionManager) {
        self.session = session
        self.passkeys = PasskeyCoordinator(owner: session)
    }

    public var body: some View {
        NavigationStack {
            Form {
                AccountView(session: session, passkeys: passkeys)

                Section {
                    Link(destination: URL(string: "\(serverHost)/dashboard#tokens")!) {
                        Label("API tokens for agents and shortcuts", systemImage: "key")
                    }
                } header: {
                    Text("Automation")
                } footer: {
                    Text("A script, agent, or the share-sheet shortcut uses its own API token.\u{00A0} Create and revoke tokens on the website dashboard.")
                        .font(.caption)
                }

                Section("Website") {
                    Picker("Website", selection: $serverHost) {
                        Text("fleetlink.online").tag("https://fleetlink.online")
                        Text("fleetlink.app").tag("https://fleetlink.app")
                    }
                }

                Section("Opens links from") {
                    Text("fleetlink.online")
                    Text("fleetlink.app")
                }

                Section("On the web") {
                    Link(destination: URL(string: "\(serverHost)/instructions")!) {
                        Label("Instructions", systemImage: "book")
                    }
                    Link(destination: URL(string: "\(serverHost)/privacy")!) {
                        Label("Privacy", systemImage: "hand.raised")
                    }
                    Link(destination: URL(string: "\(serverHost)/api/shortcut/download")!) {
                        Label("Share-sheet shortcut", systemImage: "square.and.arrow.up")
                    }
                    Link(destination: URL(string: serverHost)!) {
                        Label("Preview on the website", systemImage: "safari")
                    }
                }

                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }
}
