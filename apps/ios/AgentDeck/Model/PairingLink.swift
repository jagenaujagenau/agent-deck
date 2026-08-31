import Foundation

/// The QR on the bridge's pairing page says `agentdeck://pair?url=…&code=…`.
/// Scanning it with the phone's camera lands here: the link is the whole
/// pairing ceremony — address and one-time code — so the app can connect
/// without anyone typing either. Mirrored from Android's `PairingLink.kt`.
struct PairingLink: Equatable {
    var url: String
    var code: String
}

func parsePairingLink(_ link: String) -> PairingLink? {
    guard link.hasPrefix("agentdeck://pair?"),
          let components = URLComponents(string: link),
          let items = components.queryItems
    else { return nil }
    let field = { (name: String) in items.first { $0.name == name }?.value }
    guard let url = field("url"), url.hasPrefix("http://") || url.hasPrefix("https://"),
          let code = field("code"), code.count == 6, code.allSatisfy(\.isNumber)
    else { return nil }
    return PairingLink(url: url, code: code)
}
