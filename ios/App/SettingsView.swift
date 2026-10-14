import SwiftUI

public struct SettingsView: View {
    @ObservedObject var session: SessionManager
    @ObservedObject private var apple: AppleSignInCoordinator
    @ObservedObject private var webAuth: WebAuthSession

    @AppStorage("fleetlink_server_host") private var serverHost: String = "https://fleetlink.online"

    public init(session: SessionManager) {
        self.session = session
        self.apple = AppleSignInCoordinator(owner: session)
        self.webAuth = WebAuthSession(owner: session)
    }

    public var body: some View {
        NavigationStack {
            Form {
                AccountView(session: session, webAuth: webAuth, apple: apple)

                Section {
                    SecureField("Sign-in code", text: $session.bearerSecret)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("bearerTokenField")
                        .accessibilityLabel("Automation sign-in code")
                } header: {
                    Text("Automation")
                } footer: {
                    Text("Only for a script or shortcut that shares for you.  It is separate from Sign in with Apple.  Leave it blank if you only use the buttons above.")
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
            .navigationTitle("Settings")
        }
    }
}
