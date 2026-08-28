import Foundation
import Security

/// The device token lives in the Keychain and nowhere else.
///
/// `kSecAttrAccessibleAfterFirstUnlock` rather than `WhenUnlocked`: the app
/// reconnects and posts approval notifications from the background, and a
/// token it cannot read on a locked phone is a deck that goes silent in
/// exactly the situation the phone exists for.
enum Keychain {
    private static let service = "dev.agentdeck.ios.bridge"

    static func store(_ token: String, account: String) {
        let data = Data(token.utf8)
        var query = base(account: account)
        SecItemDelete(query as CFDictionary)
        guard !token.isEmpty else { return }
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    static func read(account: String) -> String? {
        var query = base(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func clear(account: String) {
        SecItemDelete(base(account: account) as CFDictionary)
    }

    private static func base(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
