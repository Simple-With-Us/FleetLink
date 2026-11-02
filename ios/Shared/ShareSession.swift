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
        guard let q = query() else { return false }
        guard let token, !token.isEmpty else {
            let status = SecItemDelete(q as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }
        guard let host = allowedOrigin(origin) else { _ = save(nil); return false }
        let credential = Credential(token: token, origin: host)
        if read() == credential { return true }
        guard let data = try? JSONEncoder().encode(credential) else { return false }
        let attrs: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            return SecItemAdd(q.merging(attrs) { _, new in new } as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }
}
