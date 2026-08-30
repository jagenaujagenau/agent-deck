import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The golden fixture's homeState section, executed against the Swift
/// implementation. The same corpus drives HomePolicy.kt (mobile JVM test), so
/// the two home decks answering differently is a failing build instead of a
/// drifting comment.
final class HomeStateParityTests: XCTestCase {
    private struct Case: Decodable {
        let `case`: String
        let state: String
        let approval: Bool
        let question: Bool
        let questionEvent: Bool
        let archived: Bool
        let seen: Bool
        let lastSeenAt: String
        let expect: String
    }

    private struct Section: Decodable {
        let now: String
        let sectionOrder: [String]
        let attentionStates: [String]
        let cases: [Case]
    }

    private struct Corpus: Decodable {
        let homeState: Section
    }

    private let names: [String: HomeAgentState] = [
        "failed": .failed,
        "approval-required": .approvalRequired,
        "question": .question,
        "input-required": .inputRequired,
        "done": .done,
        "running": .running,
        "paused": .paused,
        "recently-completed": .recentlyCompleted,
        "history": .history,
    ]

    private func section() throws -> Section {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(
                "packages/bridge-client/fixtures/attention-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: candidate))
                    .homeState
            }
            directory.deleteLastPathComponent()
        }
        throw XCTSkip("attention-parity.json not found above \(#filePath)")
    }

    private func agent(for entry: Case) throws -> Agent {
        var document: [String: Any] = [
            "id": "a1",
            "state": entry.state,
            "lastSeenAt": entry.lastSeenAt,
        ]
        if entry.approval {
            document["pendingApproval"] = [
                "id": "r1", "tool": "Bash", "detail": "run",
                "createdAt": "2026-08-30T11:55:00Z", "expiresAt": "2026-08-30T12:10:00Z",
            ]
        }
        if entry.question {
            document["pendingQuestion"] = [
                "id": "r2", "question": "Which?", "options": ["A"],
                "createdAt": "2026-08-30T11:55:00Z", "expiresAt": "2026-08-30T12:10:00Z",
            ]
        }
        if entry.questionEvent {
            document["events"] = [
                ["id": "q1", "kind": "question", "summary": "Choose",
                 "createdAt": "2026-08-30T11:55:00Z"],
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: document)
        return try JSONDecoder().decode(Agent.self, from: data)
    }

    func testTheSectionOrderIsTheCorpusOrder() throws {
        let order = try section().sectionOrder.map { names[$0]! }
        XCTAssertEqual(order, HomeAgentState.allCases)
    }

    func testAmberIsReservedForExactlyTheCorpusAttentionStates() throws {
        let attention = Set(try section().attentionStates.map { names[$0]! })
        for state in HomeAgentState.allCases {
            XCTAssertEqual(state.attention, attention.contains(state), "\(state)")
        }
    }

    func testEveryPresentationCaseAnswersAsTheCorpusSays() throws {
        let section = try section()
        XCTAssertFalse(section.cases.isEmpty)
        guard let now = Timestamps.parse(section.now) else {
            return XCTFail("corpus now is unreadable")
        }
        for entry in section.cases {
            XCTAssertEqual(
                homeAgentState(
                    try agent(for: entry), archived: entry.archived, seen: entry.seen, now: now),
                names[entry.expect]!,
                entry.case
            )
        }
    }
}
