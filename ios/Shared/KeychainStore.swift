import Foundation
import Security

/// Minimal Keychain wrapper for FleetLink secrets.
///
/// Everything the app stores here is a credential, so nothing in this file ever
/// writes to `UserDefaults` and nothing is logged.  Both items use
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: the account session has a
/// 14-day server-side lifetime and must still be readable after a reboot (the
/// device has been unlocked once since boot, which is what "after first unlock"
/// means), while `ThisDeviceOnly` keeps the value out of an iCloud Keychain
/// backup so a restored device cannot silently inherit someone else's session.
enum Keychain {
    private static let service = "online.fleetlink.ios"

    static func set(_ value: String?, account: String) {
        guard let value, !value.isEmpty else {
            remove(account: account)
            return
        }
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { current, _ in current }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    static func get(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func remove(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// The signed-in account as `GET /api/me` reports it.
public struct SessionUser: Codable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let displayName: String?
    public let email: String?

    enum CodingKeys: String, CodingKey {
        case id, role, email
        case displayName = "display_name"
    }

    /// Primary line for the account card: a display name when the provider gave
    /// one, otherwise the email, otherwise the opaque account id.
    public var primaryLabel: String {
        if let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return name
        }
        if let email = email?.trimmingCharacters(in: .whitespacesAndNewlines), !email.isEmpty {
            return email
        }
        return "Account \(id.prefix(8))"
    }

    public var secondaryLabel: String? {
        guard email != nil, email != displayName else { return nil }
        return email
    }

    public var isAdmin: Bool { role == "admin" }
}