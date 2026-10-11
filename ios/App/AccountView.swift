import AuthenticationServices
import SwiftUI

/// The account card: signed out shows the three providers, signed in shows who
/// you are with a sign-out button.  Every string is Title Case and uses two
/// spaces between sentences.
struct AccountView: View {
    @ObservedObject var session: SessionManager
    @ObservedObject var webAuth: WebAuthSession
    @ObservedObject var apple: AppleSignInCoordinator

    @State private var isSigningIn = false

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
            Text("Signed In With A FleetLink Account.  Your Session Is Stored Securely On This Device.")
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
                Text("Sign Out")
            }
        }
        .disabled(isSigningIn)
        .accessibilityIdentifier("signOutButton")
    }

    // MARK: - Signed Out

    @ViewBuilder
    private var signedOut: some View {
        Text("Sign In To View Your Shares, Create Custom Slugs, And Manage Agent Tokens.  Your Session Is Stored In The Keychain, Never In Plain Text.")
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
        .disabled(isSigningIn)
        .accessibilityIdentifier("signInWithAppleButton")

        ForEach(WebAuthSession.Provider.allCases, id: \.self) { provider in
            Button {
                Task {
                    isSigningIn = true
                    do {
                        try await webAuth.signIn(with: provider)
                    } catch {
                        session.report(error: (error as? WebAuthSession.Failure)?.errorDescription
                            ?? "Sign-In With \(provider.displayName) Could Not Start.")
                    }
                    isSigningIn = false
                }
            } label: {
                HStack {
                    if isSigningIn {
                        ProgressView().controlSize(.small)
                    }
                    Text("Continue With \(provider.displayName)")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
            .disabled(isSigningIn)
            .accessibilityIdentifier("signInWith\(provider.rawValue.capitalized)")
        }
    }
}