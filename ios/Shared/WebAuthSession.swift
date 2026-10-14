/// GitHub and Google sign-in are deferred.  PasskeyCoordinator is the account login.
/// This type stays so the web-session cookie path can be revived later.
import AuthenticationServices
import Combine
import Foundation
import WebKit

/// Drives the browser sign-in for GitHub and Google, then lifts the `fl_session`
/// cookie out of the web view's cookie store into the Keychain.
///
/// The OAuth flow starts at the account origin `/auth/<provider>/start`, which
/// 302s to the provider and comes back to `/auth/<provider>/callback`.  On
/// success the worker sets `fl_session` and 303s to `/`.  The cookie is
/// `HttpOnly`, so page JavaScript cannot read it; we read it from
/// `WKHTTPCookieStore` on the shared web data store, which does return
/// `HttpOnly` cookies.
///
/// We never fabricate an `Origin` header anywhere in this flow.
@MainActor
public final class WebAuthSession: NSObject, ObservableObject {
    public enum Provider: String, CaseIterable, Sendable {
        case github
        case google

        public var displayName: String {
            switch self {
            case .github: return "GitHub"
            case .google: return "Google"
            }
        }
    }

    /// Why a sign-in attempt ended.  Every case maps to a user-facing message in
    /// the Settings screen, so failure is never silent.
    public enum Failure: LocalizedError, Equatable {
        case canceled
        case providerUnavailable
        case providerError(String)
        case noSessionCookie
        case network(String)

        public var errorDescription: String? {
            switch self {
            case .canceled:
                return "Sign-in was cancelled."
            case .providerUnavailable:
                return "Sign-in is not available right now.\u{00A0} Try again later."
            case .providerError(let detail):
                return detail.isEmpty ? "Sign-in could not finish.\u{00A0} Try again." : detail
            case .noSessionCookie:
                return "Sign-in finished without a session.\u{00A0} Try again."
            case .network:
                return "Could not reach the sign-in service.\u{00A0} Check your connection."
            }
        }
    }

    @Published public private(set) var isPresenting: Bool = false
    private var session: ASWebAuthenticationSession?
    private var pollTask: Task<Void, Never>?
    private weak var owner: SessionManager?

    public init(owner: SessionManager) {
        self.owner = owner
        super.init()
    }

    public func signIn(with provider: Provider) async throws {
        let start = SessionManager.accountOrigin.appending(path: "auth/\(provider.rawValue)/start")
        // The callback finishes with a 303 to `/`, which is not a custom scheme,
        // so the completion handler below is not the success signal; the cookie
        // poll is.  The handler still catches cancellation and hard failures.
        let session = ASWebAuthenticationSession(url: start, callbackURLScheme: nil) { [weak self] url, error in
            Task { @MainActor in
                guard let self else { return }
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    self.finish(with: .failure(Failure.canceled))
                    return
                }
                if let url, url.path == "/" || url.path.isEmpty {
                    // Redirect landed back on the portal.  Fall through to the cookie read.
                    return
                }
                if error != nil {
                    self.finish(with: .failure(Failure.network("")))
                }
            }
        }
        session.presentationContextProvider = self
        // A non-ephemeral session writes into the shared web data store, which
        // is what lets us read the cookie back below.  An ephemeral session uses
        // an isolated store, and `ASWebAuthenticationSession.cookieStore` is not
        // available in this SDK, so an ephemeral one would strand the session.
        // Side effect, accepted: the provider's own login cookie persists in the
        // shared store, exactly as if the user had signed in through Safari.
        session.prefersEphemeralWebBrowserSession = false

        self.session = session
        isPresenting = true
        if !session.start() {
            finish(with: .failure(Failure.providerError("The sign-in window could not open.\u{00A0} Try again.")))
            return
        }

        // The callback ends in a 303 to `/`, which is not a custom scheme, so
        // `ASWebAuthenticationSession` does not hand us a callback URL.  Instead
        // poll the shared cookie store for the cookie the worker just set.
        let deadline = Date().addingTimeInterval(300)
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled, Date() < deadline {
                try? await Task.sleep(nanoseconds: 400_000_000)
                guard let self else { return }
                if let raw = await self.currentSessionCookie() {
                    self.finish(with: .success(raw))
                    return
                }
            }
            guard let self, !Task.isCancelled else { return }
            self.finish(with: .failure(Failure.noSessionCookie))
        }
    }

    private func currentSessionCookie() async -> String? {
        let store = WKWebsiteDataStore.default().httpCookieStore
        let cookies = await withCheckedContinuation { (c: CheckedContinuation<[HTTPCookie], Never>) in
            store.getAllCookies { c.resume(returning: $0) }
        }
        // Scoped to a FleetLink host so an unrelated site's cookie of the same
        // name can never be adopted.
        return cookies.first {
            $0.name == SessionManager.sessionCookieName
                && ($0.domain.contains("fleetlink.app") || $0.domain.contains("fleetlink.online"))
        }?.value
    }

    private func finish(with result: Result<String, Failure>) {
        pollTask?.cancel()
        pollTask = nil
        session?.cancel()
        session = nil
        isPresenting = false

        switch result {
        case .success(let raw):
            owner?.adoptSessionCookie(rawValue: raw)
        case .failure(let failure):
            owner?.report(error: failure.errorDescription)
        }
    }

    /// Called by the Settings screen once the cookie is in hand.
    public func completeSignIn() async {
        isPresenting = false
        await owner?.refreshSession()
    }
}

extension WebAuthSession: ASWebAuthenticationPresentationContextProviding {
    public nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.flatMap { $0.windows }.first
        return window ?? ASPresentationAnchor()
    }
}