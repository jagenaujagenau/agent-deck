import XCTest
@testable import AgentDeckPolicy

/// The pairing deep link, parsed the same way Android's PairingLinkTest pins.
final class PairingLinkTests: XCTestCase {
    func testTheQRsOwnLinkParsesToItsAddressAndCode() {
        XCTAssertEqual(
            parsePairingLink("agentdeck://pair?url=http%3A%2F%2F192.168.1.5%3A3000&code=123456"),
            PairingLink(url: "http://192.168.1.5:3000", code: "123456"))
    }

    func testATailnetHTTPSAddressIsAsGoodAsALANOne() {
        XCTAssertEqual(
            parsePairingLink("agentdeck://pair?url=https%3A%2F%2Fbridge.tail1234.ts.net&code=000042"),
            PairingLink(url: "https://bridge.tail1234.ts.net", code: "000042"))
    }

    func testAnythingShortOfAnAddressPlusASixDigitCodeIsRefused() {
        XCTAssertNil(parsePairingLink("agentdeck://pair?url=http%3A%2F%2Fx&code=12345"))
        XCTAssertNil(parsePairingLink("agentdeck://pair?code=123456"))
        XCTAssertNil(parsePairingLink("agentdeck://pair?url=ftp%3A%2F%2Fx&code=123456"))
        XCTAssertNil(parsePairingLink("agentdeck://agent/abc"))
        XCTAssertNil(parsePairingLink("https://example.com/?url=http%3A%2F%2Fx&code=123456"))
    }
}
