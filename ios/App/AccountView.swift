import SwiftUI

/// The account card.  Passkeys are the only account login.  Operator secrets
/// stay in the separate admin-token field.
struct AccountView: View {
    @ObservedObject var session: SessionManager
    @ObservedObject var passkeys: PasskeyCoordinator

    @State private var displayName = ""
    @State private var email = ""

    private var isBusy: Bool { passkeys.isPresenting || session.isCheckingSession }

    var body: some View {
        Section("Account") {
            if let user = session.user {
                signedIn(user)
            } else {
                signedOut
            }

            if let error = session.lastError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundColor(.orange)
                    .accessibilityIdentifier("accountError")
            }
        }
    }

    @ViewBuilder
    private func signedIn(_ user: SessionUser) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(user.primaryLabel)
                    .font(.headline)
                    .accessibilityIdentifier("accountName")
                Spacer()
                if user.isAdmin {
                    Text("Admin")
                        .font(.caption2.bold())
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.accentColor.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            if let email = user.secondaryLabel {
                Text(email)
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .accessibilityIdentifier("accountEmail")
            }
            Text("Signed In With A Passkey.  The Session Token Is Stored In The Keychain.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 2)

        Button(role: .destructive) {
            Task { await session.signOut() }
        } label: {
            Text("Sign Out")
        }
        .disabled(isBusy)
        .accessibilityIdentifier("signOutButton")
    }

    @ViewBuilder
    private var signedOut: some View {
        Text("Create A Passkey Or Sign In With One You Already Have.  FleetLink Does Not Store A Password For This Account.")
            .font(.caption)
            .foregroundColor(.secondary)

        TextField("Display Name", text: $displayName)
            .textContentType(.name)
            .accessibilityIdentifier("passkeyDisplayName")
        TextField("Email (Optional)", text: $email)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("passkeyEmail")

        Button {
            Task { await passkeys.createPasskey(displayName: displayName, email: email) }
        } label: {
            Text("Create A Passkey")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(isBusy)
        .accessibilityIdentifier("createPasskeyButton")

        Button {
            Task { await passkeys.signIn(email: email) }
        } label: {
            Text("Sign In With A Passkey")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(isBusy)
        .accessibilityIdentifier("signInPasskeyButton")
    }
}
