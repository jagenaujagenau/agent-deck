import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The golden fixture's timeline section, executed against the Swift fold.
/// The same corpus drives ChatTimeline.kt (JVM test), so the two mobile apps
/// telling a session differently is a failing build.
final class TimelineParityTests: XCTestCase {
    private struct Case: Decodable {
        let `case`: String
        let events: [FixtureEvent]
        let expect: [String]
    }

    private struct FixtureEvent: Decodable {
        let id: String
        let kind: String
        let summary: String
        let detail: String?
        let tool: String?
        let createdAt: String
    }

    private struct Corpus: Decodable {
        struct Timeline: Decodable { let cases: [Case] }
        let timeline: Timeline
    }

    private func cases() throws -> [Case] {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(
                "packages/bridge-client/fixtures/attention-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: candidate))
                    .timeline.cases
            }
            directory.deleteLastPathComponent()
        }
        throw XCTSkip("attention-parity.json not found above \(#filePath)")
    }

    private func agentEvent(_ fixture: FixtureEvent) throws -> AgentEvent {
        var document: [String: Any] = [
            "id": fixture.id,
            "kind": fixture.kind,
            "summary": fixture.summary,
            "createdAt": fixture.createdAt,
        ]
        if let detail = fixture.detail { document["detail"] = detail }
        if let tool = fixture.tool { document["tool"] = tool }
        let data = try JSONSerialization.data(withJSONObject: document)
        return try JSONDecoder().decode(AgentEvent.self, from: data)
    }

    func testEveryTimelineCaseFoldsAsTheCorpusSays() throws {
        let corpus = try cases()
        XCTAssertFalse(corpus.isEmpty)
        for entry in corpus {
            let events = try entry.events.map(agentEvent)
            let folded = chatTimeline(events).map { item in
                switch item {
                case .message(let message):
                    "message:\(message.role == .user ? "user" : "agent")"
                case .activity(let work):
                    "activity:\(work.count)"
                }
            }
            XCTAssertEqual(folded, entry.expect, entry.case)
        }
    }
}
