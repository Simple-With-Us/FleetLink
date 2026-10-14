import SwiftUI

/// The account card.  Passkeys are the account login.  The automation
/// sign-in code stays in the field below this card.
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
                    Text("Account owner")
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
            Text("Signed in with a passkey.\u{00A0} This sign-in stays on this device.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 2)

        Button(role: .destructive) {
            Task { await session.signOut() }
        } label: {
            Text("Sign out")
        }
        .disabled(isBusy)
        .accessibilityIdentifier("signOutButton")
    }

    @ViewBuilder
    private var signedOut: some View {
        Text("Create a passkey, or sign in with one you already have.\u{00A0} FleetLink does not store a password for this account.")
            .font(.caption)
            .foregroundColor(.secondary)

        TextField("Name", text: $displayName)
            .textContentType(.name)
            .accessibilityIdentifier("passkeyDisplayName")
        TextField("Email (optional)", text: $email)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("passkeyEmail")

        Button {
            Task { await passkeys.createPasskey(displayName: displayName, email: email) }
        } label: {
            Text("Create a passkey")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(isBusy)
        .accessibilityIdentifier("createPasskeyButton")

        Button {
            Task { await passkeys.signIn(email: email) }
        } label: {
            Text("Sign in with a passkey")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(isBusy)
        .accessibilityIdentifier("signInPasskeyButton")
    }
}
