import Foundation
import Security

/// Only the containing app and its signed Share extension can read this group.
/// No credentials are written to preferences, shared files, URLs or logs.
enum ShareSession {
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
    static func read() -> String? {
        guard var q = query() else { return nil }
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    @discardableResult static func save(_ token: String?) -> Bool {
        guard let q = query() else { return false }
        guard let token, !token.isEmpty else {
            let status = SecItemDelete(q as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }
        let attrs: [String: Any] = [kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            return SecItemAdd(q.merging(attrs) { _, new in new } as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }
}
