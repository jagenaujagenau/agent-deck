import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The golden fixture's `conversationDays` section, executed against the Swift
/// separator. The Kotlin timeline has drawn these labels since it learned to
/// span days; iOS drew none at all, which is only visible when the two phones
/// are held side by side — so the answers live in the corpus and both
/// implementations are held to them.
final class ConversationDaysParityTests: XCTestCase {
    private func section() throws -> [String: Any] {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(
                "packages/bridge-client/fixtures/attention-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: candidate))
                // SAFETY: the corpus is this repository's own fixture; a shape
                // change here is exactly the failure this suite exists to show.
                let root = raw as! [String: Any]
                return root["conversationDays"] as! [String: Any]
            }
            directory.deleteLastPathComponent()
        }
        throw XCTSkip("attention-parity.json not found above \(#filePath)")
    }

    func testEveryDayCaseAnswersAsTheCorpusSays() throws {
        let section = try section()
        // SAFETY: same fixture, same reason as above.
        let cases = section["cases"] as! [[String: Any]]
        let todayText = section["today"] as! String
        XCTAssertFalse(cases.isEmpty)

        for entry in cases {
            let name = entry["case"] as? String ?? ""
            let zone = TimeZone(identifier: entry["zone"] as! String)!
            // "today" is a calendar day, and which instant that is depends on
            // the zone the case is read in — so it is resolved per case rather
            // than parsed once as a UTC midnight.
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let parts = todayText.split(separator: "-").map { Int($0)! }
            let today = calendar.date(
                from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))!

            let separator = ConversationDays.separatorBefore(
                previous: entry["previous"] as? String,
                current: entry["current"] as! String,
                today: today,
                zone: zone)
            XCTAssertEqual(separator, entry["separator"] as? String, name)
        }
    }
}
