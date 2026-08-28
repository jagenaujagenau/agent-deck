import Foundation

/// Where the bridge is and what this device is called, in `UserDefaults`; the
/// token itself is in the Keychain, keyed by the address it was issued for.
///
/// Keying by address matters: point the app at a different bridge and the old
/// bridge's token must not travel with it. It would be refused, and a refusal
/// reads as "your credential is wrong" rather than "that is a different bridge".
struct Connection: Equatable {
    var baseURL: String = ""
    var deviceName: String = Connection.defaultDeviceName

    /// Not read from `UIDevice`: since iOS 16 that returns the model name
    /// unless the app is entitled, so it would offer "iPhone" and look like it
    /// had asked the system for it. The connect screen lets you type a better one.
    static let defaultDeviceName = "iPhone"

    var isConfigured: Bool { !baseURL.isEmpty }
}

enum ConnectionStore {
    private static let urlKey = "agentdeck.bridge.url"
    private static let deviceKey = "agentdeck.device.name"

    static func load() -> Connection {
        let defaults = UserDefaults.standard
        return Connection(
            baseURL: defaults.string(forKey: urlKey) ?? "",
            deviceName: defaults.string(forKey: deviceKey) ?? Connection.defaultDeviceName
        )
    }

    static func save(_ connection: Connection) {
        let defaults = UserDefaults.standard
        defaults.set(connection.baseURL, forKey: urlKey)
        defaults.set(connection.deviceName, forKey: deviceKey)
    }

    static func token(for baseURL: String) -> String {
        Keychain.read(account: BridgeClient.normalize(baseURL)) ?? ""
    }

    static func store(token: String, for baseURL: String) {
        Keychain.store(token, account: BridgeClient.normalize(baseURL))
    }

    static func forget(_ baseURL: String) {
        Keychain.clear(account: BridgeClient.normalize(baseURL))
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: urlKey)
    }
}
