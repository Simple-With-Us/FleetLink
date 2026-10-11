import Foundation
import SwiftUI

/// Owns the signed-in session and the separately-kept admin/agent bearer secret.
///
/// Two credentials, deliberately kept apart:
///
/// 1. **Account session** — the `fl_session` cookie issued by the OAuth callback.
///    It lives in the Keychain and is sent as a `Cookie` header.  It identifies a
///    human account and supports the read path (`GET /api/me`, `GET /api/shares`).
/// 2. **Admin / agent bearer secret** — the pasted `X-Fleet-Admin` style token the
///    fleet's MCP server and agents already use.  It is unchanged, still works,
///    and remains the only credential that can perform the `sameOrigin`-gated
///    writes from a native client.
///
/// The app never sets an `Origin` header by hand.  See `WebAuthSession` and the
/// PR body for why.
@MainActor
public final class SessionManager: ObservableObject {
    private static let sessionCookieAccount = "account.session"
    private static let bearerSecretAccount = "account.bearerSecret"
    public static let sessionCookieName = "fl_session"

    /// The portal origin that issues sessions.  `ADMIN_HOST` is `fleetlink.app`.
    public static let portalOrigin = URL(string: "https://fleetlink.app")!

    @Published public private(set) var user: SessionUser?
    @Published public private(set) var isCheckingSession: Bool = false
    @Published public private(set) var lastError: String?

    /// The admin/agent bearer secret.  Kept separate from the account session and
    /// exposed so the Settings screen can keep offering it.
    @Published public var bearerSecret: String {
        didSet { Keychain.set(bearerSecret.trimmingCharacters(in: .whitespacesAndNewlines), account: Self.bearerSecretAccount) }
    }

    public init() {
        bearerSecret = Keychain.get(account: Self.bearerSecretAccount) ?? ""
        user = nil
    }

    public var isSignedIn: Bool { user != nil }

    /// The raw `fl_session` value, read from the Keychain on demand.
    public var sessionCookieValue: String? {
        guard let cookie = Keychain.get(account: Self.sessionCookieAccount) else { return nil }
        let parts = cookie.split(separator: "=", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        return String(parts[1])
    }

    /// The ready-to-send `Cookie` header value, or `nil` when signed out.
    public var sessionCookieHeader: String? {
        guard let value = sessionCookieValue, !value.isEmpty else { return nil }
        return "\(Self.sessionCookieName)=\(value)"
    }

    /// Report a sign-in failure to the account card.  Coordinators call this so
    /// every provider surfaces its own message in one place.
    public func report(error message: String?) {
        lastError = message
    }

    /// Accept a `fl_session` value captured from the web sign-in cookie store.
    public func adoptSessionCookie(rawValue: String) {
        Keychain.set("\(Self.sessionCookieName)=\(rawValue)", account: Self.sessionCookieAccount)
        lastError = nil
    }

    public func clearSessionCookie() {
        Keychain.remove(account: Self.sessionCookieAccount)
    }

    /// Validate the stored cookie against `GET /api/me` and load the account.
    /// Returns `true` when a live session is present.
    @discardableResult
    public func refreshSession() async -> Bool {
        guard let header = sessionCookieHeader else {
            user = nil
            return false
        }
        isCheckingSession = true
        defer { isCheckingSession = false }
        do {
            var request = URLRequest(url: Self.portalOrigin.appendingPathComponent("api/me"))
            request.httpMethod = "GET"
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue(header, forHTTPHeaderField: "Cookie")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                user = nil
                return false
            }
            if http.statusCode == 401 {
                // Expired, revoked or disabled.  Drop it so the UI shows signed out.
                clearSessionCookie()
                user = nil
                return false
            }
            guard (200...299).contains(http.statusCode) else {
                lastError = "Could Not Reach The Account Service.  Please Try Again."
                return false
            }
            user = try JSONDecoder().decode(SessionUser.self, from: data)
            lastError = nil
            return true
        } catch {
            lastError = "Could Not Reach The Account Service.  Please Check Your Connection."
            return false
        }
    }

    /// Sign out.
    ///
    /// This deliberately calls `POST /api/auth/logout`, which is the one
    /// cookie-authenticated write the worker does **not** gate behind
    /// `sameOrigin`.  `POST /logout` would return 403 from a native client.  If
    /// the network call fails we still clear the local session, because the app
    /// must not stay signed in after the user asked to leave.
    public func signOut() async {
        if let value = sessionCookieValue {
            var request = URLRequest(url: Self.portalOrigin.appendingPathComponent("api/auth/logout"))
            request.httpMethod = "POST"
            request.setValue("\(Self.sessionCookieName)=\(value)", forHTTPHeaderField: "Cookie")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            try? await URLSession.shared.data(for: request)
        }
        clearSessionCookie()
        user = nil
        lastError = nil
    }
}