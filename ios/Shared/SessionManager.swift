import Foundation
import SwiftUI

/// Owns the signed-in passkey session.
///
/// The session is a bearer token from passkey sign-up or sign-in.  It lives in
/// the Keychain and is sent as `Authorization: Bearer` on every account call, so
/// everything the app lists, creates, renews, or deletes belongs to this account.
///
/// The app never sets an `Origin` header by hand.  See `WebAuthSession`.
@MainActor
public final class SessionManager: ObservableObject {
    private static let sessionCookieAccount = "account.session"
    /// Where builds before multi-user kept a pasted operator secret.  It is removed on launch.
    private static let retiredSecretAccount = "account.bearerSecret"
    private static let passkeyBearerAccount = "account.passkeyBearer"
    public static let sessionCookieName = "fl_session"

    /// Account API host.  Passkeys are bound to one RP ID, so this stays on the
    /// account host chosen in DEPLOY.md.  The Info.plist key overrides the default.
    public static var accountOrigin: URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "FleetLinkAccountOrigin") as? String,
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "https://fleetlink.online")!
    }

    public static var portalOrigin: URL { accountOrigin }

    @Published public private(set) var user: SessionUser?
    @Published public private(set) var isCheckingSession: Bool = false
    @Published public private(set) var lastError: String?

    @Published public private(set) var usage: AccountUsage?

    public init() {
        Keychain.remove(account: Self.retiredSecretAccount)
        user = nil
    }

    /// The credential for account API calls: the passkey session, or empty when signed out.
    public var apiToken: String { passkeyBearer ?? "" }

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

    /// The passkey session token.  Sent as `Authorization: Bearer`, never as a cookie.
    public var passkeyBearer: String? {
        let value = Keychain.get(account: Self.passkeyBearerAccount)
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    public func adoptBearerToken(_ token: String) {
        Keychain.set(token, account: Self.passkeyBearerAccount)
        lastError = nil
    }

    public func clearBearerToken() {
        Keychain.remove(account: Self.passkeyBearerAccount)
    }

    /// Validate the stored bearer token against `GET /api/me`.
    /// Returns `true` when a live session is present.
    @discardableResult
    public func refreshSession() async -> Bool {
        guard let token = passkeyBearer else {
            user = nil
            return false
        }
        isCheckingSession = true
        defer { isCheckingSession = false }
        do {
            var request = URLRequest(url: Self.accountOrigin.appending(path: "api/me"))
            request.httpMethod = "GET"
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("ios", forHTTPHeaderField: "X-Fleet-Client")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                user = nil
                return false
            }
            if http.statusCode == 401 {
                clearBearerToken()
                user = nil
                return false
            }
            guard (200...299).contains(http.statusCode) else {
                lastError = "Could not reach FleetLink.\u{00A0} Try again."
                return false
            }
            let me = try JSONDecoder().decode(MeResponse.self, from: data)
            user = me.user
            usage = me.usage
            lastError = nil
            return true
        } catch {
            lastError = "Could not reach FleetLink.\u{00A0} Check your connection."
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
        if let token = passkeyBearer {
            var request = URLRequest(url: Self.accountOrigin.appending(path: "api/auth/logout"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("ios", forHTTPHeaderField: "X-Fleet-Client")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            try? await URLSession.shared.data(for: request)
        }
        clearBearerToken()
        clearSessionCookie()
        user = nil
        usage = nil
        lastError = nil
    }
}

/// `GET /api/me`: the account, its usage, and its quotas.
private struct MeResponse: Decodable {
    let user: SessionUser
    let usage: AccountUsage?
}

public struct AccountUsage: Codable, Equatable, Sendable {
    public let shares: Int
    public let bytes: Int64
}