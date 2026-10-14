import AuthenticationServices
import SwiftUI

/// The account card: signed out shows the three providers, signed in shows who
/// you are with a sign-out button.  Sentences use two spaces.
struct AccountView: View {
    @ObservedObject var session: SessionManager
    @ObservedObject var webAuth: WebAuthSession
    @ObservedObject var apple: AppleSignInCoordinator

    @State private var isSigningIn = false

    /// True while any provider flow is still on screen.  `webAuth.signIn(with:)`
    /// returns as soon as it starts polling, so the busy state has to follow the
    /// coordinator rather than the tap, or a second flow could be started on top
    /// of the first.
    private var isBusy: Bool { isSigningIn || webAuth.isPresenting || apple.isPresenting }

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

    // MARK: - Signed In

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
            Text("Signed in to FleetLink.  This sign-in stays on this device.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 2)

        Button(role: .destructive) {
            Task {
                isSigningIn = true
                await session.signOut()
                isSigningIn = false
            }
        } label: {
            HStack {
                if isSigningIn {
                    ProgressView().controlSize(.small)
                }
                Text("Sign out")
            }
        }
        .disabled(isBusy)
        .accessibilityIdentifier("signOutButton")
    }

    // MARK: - Signed Out

    @ViewBuilder
    private var signedOut: some View {
        Text("Sign in to see your links and choose a short name.  This sign-in stays on this device.")
            .font(.caption)
            .foregroundColor(.secondary)

        SignInWithAppleButton(.signIn) { request in
            request.requestedScopes = [.fullName, .email]
        } onCompletion: { result in
            switch result {
            case .success(let authorization): apple.handle(authorization: authorization)
            case .failure(let error): apple.handle(error: error)
            }
        }
        .signInWithAppleButtonStyle(.black)
        .frame(height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .disabled(isBusy)
        .accessibilityIdentifier("signInWithAppleButton")

        ForEach(WebAuthSession.Provider.allCases, id: \.self) { provider in
            Button {
                Task {
                    isSigningIn = true
                    do {
                        try await webAuth.signIn(with: provider)
                    } catch {
                        session.report(error: (error as? WebAuthSession.Failure)?.errorDescription
                            ?? "Sign in with \(provider.displayName) could not start.  Try again.")
                    }
                    isSigningIn = false
                }
            } label: {
                HStack {
                    if isBusy {
                        ProgressView().controlSize(.small)
                    }
                    Text("Continue With \(provider.displayName)")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
            .disabled(isBusy)
            .accessibilityIdentifier("signInWith\(provider.rawValue.capitalized)")
        }
    }
}