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
                    SecureField("Admin / Agent Secret Token", text: $session.bearerSecret)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("bearerTokenField")

                    Text("For Bots And Automation Only.  A Bearer Secret Is Sent As An Authorization Header, Which Is Separate From Your Account Session.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } header: {
                    Text("Admin / Agent Token")
                } footer: {
                    Text("The Fleet MCP Server And Agent Seats Sign In With A Bearer Secret.  Keep Using Them Here If You Automate FleetLink.")
                        .font(.caption)
                }

                Section("Server Endpoint") {
                    Picker("Primary Host", selection: $serverHost) {
                        Text("https://fleetlink.online (Default)").tag("https://fleetlink.online")
                        Text("https://fleetlink.app (Secondary)").tag("https://fleetlink.app")
                    }
                }

                Section("App Clip & Universal Links") {
                    HStack {
                        Text("App Clip Bundle")
                        Spacer()
                        Text("online.fleetlink.ios.Clip")
                            .font(.caption.monospaced())
                            .foregroundColor(.secondary)
                    }

                    HStack {
                        Text("Associated Domains")
                        Spacer()
                        VStack(alignment: .trailing) {
                            Text("fleetlink.online")
                            Text("fleetlink.app")
                        }
                        .font(.caption)
                        .foregroundColor(.secondary)
                    }
                }

                Section("Architecture & Fleet Coordination") {
                    HStack {
                        Text("Team ID")
                        Spacer()
                        Text("CC8UTF7ATG")
                            .font(.caption.monospaced())
                            .foregroundColor(.secondary)
                    }

                    HStack {
                        Text("Main App Bundle")
                        Spacer()
                        Text("online.fleetlink.ios")
                            .font(.caption.monospaced())
                            .foregroundColor(.secondary)
                    }

                    HStack {
                        Text("Storage Engine")
                        Spacer()
                        Text("Cloudflare R2 + D1")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                Section("On The Web") {
                    Link(destination: URL(string: "\(serverHost)/instructions/")!) {
                        Label("Instructions", systemImage: "book")
                    }
                    Link(destination: URL(string: "\(serverHost)/privacy")!) {
                        Label("Privacy", systemImage: "hand.raised")
                    }
                    Link(destination: URL(string: "\(serverHost)/api/shortcut/download")!) {
                        Label("Share Sheet Shortcut", systemImage: "square.and.arrow.up")
                    }
                    Link(destination: URL(string: serverHost)!) {
                        Label("Preview On The Website", systemImage: "safari")
                    }
                }

                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("1.0.1 Beta")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Settings & Info")
        }
    }
}
