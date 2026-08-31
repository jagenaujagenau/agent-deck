import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The golden fixture's `openRequest` section, executed against the Swift
/// derivation. The same corpus drives `OpenRequest.kt`, because "is this
/// session asking me something" is one question — and it had five answers
/// before this seam existed.
final class OpenRequestParityTests: XCTestCase {
    private struct Event: Decodable {
        let id: String
        let kind: String
        let summary: String
        let createdAt: String
    }

    private struct Case: Decodable {
        let `case`: String
        let state: String
        let approval: Bool
        let question: Bool
        let approvalExpiresAt: String?
        let questionExpiresAt: String?
        let events: [Event]?
        let expect: String
    }

    private struct Corpus: Decodable {
        struct Section: Decodable {
            let now: String
            let cases: [Case]
        }
        let openRequest: Section
    }

    private func section() throws -> Corpus.Section {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(
                "packages/bridge-client/fixtures/attention-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: candidate)).openRequest
            }
            directory.deleteLastPathComponent()
        }
        throw XCTSkip("attention-parity.json not found above \(#filePath)")
    }

    func testEveryOpenRequestCaseAnswersAsTheCorpusSays() throws {
        let section = try section()
        let now = Timestamps.parse(section.now)!
        XCTAssertFalse(section.cases.isEmpty)
        for entry in section.cases {
            var document: [String: Any] = [
                "id": "a1", "name": "Fixture", "project": "parity", "model": "test",
                "state": entry.state, "task": "", "tokens": 0, "costUsd": 0,
                "lastSeenAt": "2026-08-31T11:55:00Z",
                "events": (entry.events ?? []).map {
                    ["id": $0.id, "kind": $0.kind, "summary": $0.summary, "createdAt": $0.createdAt]
                },
            ]
            if entry.approval {
                document["pendingApproval"] = [
                    "id": "r1", "tool": "Bash", "detail": "run",
                    "createdAt": "2026-08-31T11:55:00Z",
                    "expiresAt": entry.approvalExpiresAt ?? "2026-08-31T12:10:00Z",
                ]
            }
            if entry.question {
                document["pendingQuestion"] = [
                    "id": "r2", "question": "Which?", "options": ["A"],
                    "createdAt": "2026-08-31T11:55:00Z",
                    "expiresAt": entry.questionExpiresAt ?? "2026-08-31T12:10:00Z",
                ]
            }
            let agent = try JSONDecoder().decode(
                Agent.self, from: JSONSerialization.data(withJSONObject: document))
            let answer: String = switch openRequest(agent, now: now) {
            case .approval: "approval"
            case .question: "question"
            case nil: "none"
            }
            XCTAssertEqual(answer, entry.expect, entry.case)
        }
    }
}
