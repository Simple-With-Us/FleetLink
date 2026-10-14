import AuthenticationServices
import Combine
import CryptoKit
import Foundation
import Security
import UIKit

/// Apple Sign In and the GitHub/Google web session are not presented.
///
/// The worker implements the Apple *web* flow (`/auth/apple/start` →
/// `form_post` → `/auth/apple/callback`).  That flow mints its own client
/// secret server-side and is not reachable from a native credential, so the
/// native credential is exchanged at `POST /auth/apple/native` instead.
///
/// That endpoint is not deployed yet.  When it answers 404 we surface a clear,
/// honest message and let the user fall back to the browser sign-in for GitHub
/// or Google rather than pretending sign-in worked.  The exact request and
/// response contract is written up under "Server-side follow-up" in the PR body.
@MainActor
public final class AppleSignInCoordinator: NSObject, ObservableObject {
    public enum Failure: LocalizedError, Equatable {
        case canceled
        case notConfigured
        case providerError(String)
        case exchangeUnavailable
        case rejected

        public var errorDescription: String? {
            switch self {
            case .canceled:
                return "Sign-in was cancelled."
            case .notConfigured:
                return "Sign in with Apple is not available in this version of the app."
            case .providerError(let detail):
                return detail.isEmpty ? "Apple could not finish signing in.\u{00A0} Try again." : detail
            case .exchangeUnavailable:
                return "Sign in with Apple is not available yet.\u{00A0} Use GitHub or Google for now."
            case .rejected:
                return "This account is turned off."
            }
        }
    }

    @Published public private(set) var isPresenting: Bool = false
    @Published public private(set) var isAvailable: Bool = true

    private weak var owner: SessionManager?
    private var currentNonce: String?

    /// Bundle identifier registered with Apple for this app.
    public static let serviceID = "online.fleetlink.ios"

    public init(owner: SessionManager) {
        self.owner = owner
        super.init()
        isAvailable = true
    }

    public func prepare() async {
        // Apple only reports a revoked state for a user this app has seen
        // before.  We persist no Apple user id, so there is nothing to check
        // up front: a stored session is validated against /api/me instead.
        isAvailable = true
    }

    /// Start the native Apple sign-in.  Completion arrives on the delegate.
    public func signIn() async throws {
        let nonce = Self.randomNonceString()
        currentNonce = nonce
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(nonce)

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        isPresenting = true
        controller.performRequests()
    }

    /// Handle a successful `SignInWithAppleButton` result.
    public func handle(authorization: ASAuthorization) {
        Task { @MainActor in
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                isPresenting = false
                owner?.report(error: Failure.providerError("Apple Returned An Unexpected Credential.").errorDescription)
                return
            }
            guard let tokenData = credential.identityToken,
                  let token = String(data: tokenData, encoding: .utf8) else {
                isPresenting = false
                owner?.report(error: Failure.providerError("Apple Did Not Return An Identity Token.").errorDescription)
                return
            }
            do {
                try await exchange(identityToken: token, userIdentifier: credential.user)
            } catch {
                owner?.report(error: (error as? Failure)?.errorDescription ?? error.localizedDescription)
            }
            isPresenting = false
        }
    }

    /// Handle a failed or cancelled `SignInWithAppleButton` result.
    public func handle(error: Error) {
        isPresenting = false
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            owner?.report(error: Failure.canceled.errorDescription)
            return
        }
        owner?.report(error: Failure.providerError(error.localizedDescription).errorDescription)
    }

    /// Hand the native credential to the worker, which verifies it against
    /// Apple's public keys and issues an `fl_session` cookie exactly as the web
    /// callback does.
    private func exchange(identityToken: String, userIdentifier: String) async throws {
        let url = SessionManager.accountOrigin.appending(path: "auth/apple/native")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "identity_token": identityToken,
            "user": userIdentifier
        ])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure.providerError(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw Failure.exchangeUnavailable
        }
        switch http.statusCode {
        case 200...299:
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cookie = http.value(forHTTPHeaderField: "Set-Cookie"),
                  let value = Self.sessionValue(fromSetCookie: cookie) else {
                throw Failure.exchangeUnavailable
            }
            owner?.adoptSessionCookie(rawValue: value)
            await owner?.refreshSession()
        case 404:
            throw Failure.exchangeUnavailable
        case 403:
            throw Failure.rejected
        default:
            throw Failure.exchangeUnavailable
        }
    }

    static func sessionValue(fromSetCookie header: String) -> String? {
        header.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.hasPrefix("\(SessionManager.sessionCookieName)=") }
            .flatMap { value -> String? in
                let raw = value.split(separator: "=").dropFirst().joined(separator: "=")
                guard !raw.isEmpty else { return nil }
                // Drop any attributes that rode along after the value.
                return raw.split(separator: ";").first.map(String.init)
            }
    }

    static func randomNonceString(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remaining = length
        while remaining > 0 {
            var random: UInt8 = 0
            guard SecRandomCopyBytes(kSecRandomDefault, 1, &random) == errSecSuccess else { continue }
            if charset.count > Int(random) {
                result.append(charset[Int(random)])
                remaining -= 1
            }
        }
        return result
    }

    static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

extension AppleSignInCoordinator: ASAuthorizationControllerDelegate {
    public nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        Task { @MainActor in self.handle(authorization: authorization) }
    }

    public nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        Task { @MainActor in self.handle(error: error) }
    }
}

extension AppleSignInCoordinator: ASAuthorizationControllerPresentationContextProviding {
    public nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.flatMap { $0.windows }.first
        return window ?? ASPresentationAnchor()
    }
}