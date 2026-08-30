import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The golden fixture, executed against the Swift implementation.
///
/// The same corpus drives attention.ts (bun test) and AttentionRank.kt (JVM
/// test), so three languages answering differently is a failing build instead
/// of a drifting comment.
final class AttentionParityTests: XCTestCase {
    private struct RankCase: Decodable {
        let `case`: String
        let state: String
        let blocked: Bool
        let seen: Bool
        let expect: Int
    }

    private struct SeenCase: Decodable {
        let `case`: String
        let lastSeenAt: String
        let eventAts: [String]
        let viewedAt: String?
        let localSeenAt: String?
        let expect: Bool
    }

    private struct Corpus: Decodable {
        let rank: [RankCase]
        let seen: [SeenCase]
    }

    private func corpus() throws -> Corpus {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(
                "packages/bridge-client/fixtures/attention-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: candidate))
            }
            directory.deleteLastPathComponent()
        }
        throw XCTSkip("attention-parity.json not found above \(#filePath)")
    }

    private func agent(for entry: SeenCase) throws -> Agent {
        var document: [String: Any] = [
            "id": "a1",
            "lastSeenAt": entry.lastSeenAt,
            "events": entry.eventAts.enumerated().map { index, at in
                ["id": "e\(index)", "kind": "output", "summary": "", "createdAt": at]
            },
        ]
        if let viewedAt = entry.viewedAt { document["viewedAt"] = viewedAt }
        let data = try JSONSerialization.data(withJSONObject: document)
        return try JSONDecoder().decode(Agent.self, from: data)
    }

    func testEveryRankCaseAnswersAsTheCorpusSays() throws {
        let cases = try corpus().rank
        XCTAssertFalse(cases.isEmpty)
        for entry in cases {
            XCTAssertEqual(
                attentionPriority(state: entry.state, blocked: entry.blocked, seen: entry.seen),
                entry.expect,
                entry.case
            )
        }
    }

    func testEverySeenCaseAnswersAsTheCorpusSays() throws {
        let cases = try corpus().seen
        XCTAssertFalse(cases.isEmpty)
        for entry in cases {
            var marks: [String: String] = [:]
            if let local = entry.localSeenAt { marks["a1"] = local }
            XCTAssertEqual(
                SeenPolicy.isSeen(try agent(for: entry), marks: marks),
                entry.expect,
                entry.case
            )
        }
    }
}
