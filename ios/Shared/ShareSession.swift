import Foundation
import Security

/// Only the containing app and its signed Share extension can read this group.
/// No credentials are written to preferences, shared files, URLs or logs.
enum ShareSession {
    struct Credential: Codable, Equatable {
        let token: String
        let origin: URL
    }
    static func allowedOrigin(_ value: String) -> URL? {
        guard let url = URL(string: value), url.scheme == "https",
              ["fleetlink.online", "fleetlink.app"].contains(url.host?.lowercased() ?? ""),
              url.user == nil, url.password == nil, url.port == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { return nil }
        return URL(string: "https://" + url.host!.lowercased())
    }
    private static var group: String? {
        Bundle.main.object(forInfoDictionaryKey: "FleetLinkSharedKeychainGroup") as? String
    }
    private static let account = "account.passkeyBearer"
    private static func query() -> [String: Any]? {
        guard let group, !group.isEmpty, !group.contains("$(") else { return nil }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "online.fleetlink.ios.share-session",
                kSecAttrAccount as String: account,
                kSecAttrAccessGroup as String: group]
    }
    static func read() -> Credential? {
        guard var q = query() else { return nil }
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        guard let credential = try? JSONDecoder().decode(Credential.self, from: data),
              !credential.token.isEmpty, allowedOrigin(credential.origin.absoluteString) == credential.origin else { return nil }
        return credential
    }
    @discardableResult static func save(_ token: String?, origin: String = "https://fleetlink.online") -> Bool {
        saveDiagnosed(token, origin: origin).0
    }

    /// Same write as `save`, but names the stage that failed, so the
    /// sheet-proof qualification lane can read the cause out of the
    /// accessibility tree instead of guessing from a missing readiness
    /// marker (the ca54e2d lane failed the seed without saying why).
    @discardableResult static func saveDiagnosed(_ token: String?, origin: String = "https://fleetlink.online") -> (Bool, String) {
        _save(token, origin: origin)
    }

    private static func _save(_ token: String?, origin: String) -> (Bool, String) {
        guard let q = query() else {
            guard let group, !group.isEmpty else { return (false, "group-missing") }
            return (false, "group-unexpanded")
        }
        guard let token, !token.isEmpty else {
            let status = SecItemDelete(q as CFDictionary)
            return (status == errSecSuccess || status == errSecItemNotFound) ? (true, "ok") : (false, "sec-delete-\(status)")
        }
        guard let host = allowedOrigin(origin) else { _ = save(nil); return (false, "origin-rejected") }
        let credential = Credential(token: token, origin: host)
        if read() == credential { return (true, "ok") }
        guard let data = try? JSONEncoder().encode(credential) else { return (false, "encode-failed") }
        let attrs: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            let add = SecItemAdd(q.merging(attrs) { _, new in new } as CFDictionary, nil)
            return add == errSecSuccess ? (true, "ok") : (false, "sec-add-\(add)")
        }
        return status == errSecSuccess ? (true, "ok") : (false, "sec-update-\(status)")
    }
}
