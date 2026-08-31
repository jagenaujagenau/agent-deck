import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The golden fixture's `cardText` section, executed against the Swift
/// strings. Each Agent is decoded through the shipping wire decoder, so this
/// pins the decode as well as the derivation — and every case in the corpus
/// was a live divergence between the two apps before these functions moved
/// out of their view files.
final class CardTextParityTests: XCTestCase {
    private func cases() throws -> [[String: Any]] {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(
                "packages/bridge-client/fixtures/attention-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: candidate))
                // SAFETY: the corpus is this repository's own fixture; a shape
                // change here is exactly the failure this suite exists to show.
                let root = raw as! [String: Any]
                let section = root["cardText"] as! [String: Any]
                return section["cases"] as! [[String: Any]]
            }
            directory.deleteLastPathComponent()
        }
        throw XCTSkip("attention-parity.json not found above \(#filePath)")
    }

    func testEveryCardTextCaseAnswersAsTheCorpusSays() throws {
        let cases = try cases()
        XCTAssertFalse(cases.isEmpty)
        for entry in cases {
            let name = entry["case"] as? String ?? ""
            let agent = try JSONDecoder().decode(
                Agent.self,
                from: JSONSerialization.data(withJSONObject: entry["agent"] as Any))
            if let expected = entry["usefulTask"] as? String {
                XCTAssertEqual(usefulTask(agent), expected, name)
            }
            if let expected = entry["chatTitle"] as? String {
                XCTAssertEqual(chatTitle(agent), expected, name)
            }
            if entry.keys.contains("latestReasoningPreview") {
                XCTAssertEqual(
                    latestReasoningPreview(agent), entry["latestReasoningPreview"] as? String, name)
            }
        }
    }
}
