import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The deck order, mirrored from Android's HomeDeckTest ordering case.
final class HomeOrderTests: XCTestCase {
    private func waiting(_ id: String, askedAt: String) throws -> Agent {
        let document: [String: Any] = [
            "id": id, "name": "Claude · deck · \(id)", "project": "deck",
            "model": "Claude Code", "state": "waiting", "task": "Working",
            "tokens": 0, "costUsd": 0, "lastSeenAt": askedAt,
            "events": [["id": "\(id)-ask", "kind": "question", "summary": "Q", "createdAt": askedAt]],
        ]
        return try JSONDecoder().decode(Agent.self, from: JSONSerialization.data(withJSONObject: document))
    }

    func testTheLongestStuckAskSurfacesFirstInsideAnAttentionState() throws {
        let now = Timestamps.parse("2026-08-30T12:00:00Z")!
        let ordered = homeAgentOrder(
            [
                try waiting("fresh", askedAt: "2026-08-30T11:58:00Z"),
                try waiting("stuck-an-hour", askedAt: "2026-08-30T11:00:00Z"),
                try waiting("stuck-a-while", askedAt: "2026-08-30T11:30:00Z"),
            ],
            now: now
        )
        XCTAssertEqual(ordered.map(\.id), ["stuck-an-hour", "stuck-a-while", "fresh"])
    }
}
