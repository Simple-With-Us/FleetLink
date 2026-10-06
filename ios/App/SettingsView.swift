import SwiftUI

public struct SettingsView: View {
    @AppStorage("fleetlink_auth_token") private var authToken: String = ""
    @AppStorage("fleetlink_server_host") private var serverHost: String = "https://fleetlink.online"

    @State private var showTokenSavedAlert: Bool = false

    public init() {}

    public var body: some View {
        NavigationStack {
            Form {
                Section("Authentication") {
                    SecureField("Admin / Agent Secret Token", text: $authToken)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    Text("Provide an Admin Secret or Agent Secret token to view authenticated shares and create custom slugs.")
                        .font(.caption)
                        .foregroundColor(.secondary)
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
