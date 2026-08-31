import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The cluster sentence and its diff arithmetic, mirrored from Android's
/// ChatTimelineTest. The wording is deliberately not corpus-pinned — it is
/// UI copy — but the two apps saying a run differently is still a bug, so
/// the same cases run on both sides by hand.
final class ChatSummaryTests: XCTestCase {
    private func event(
        id: String,
        kind: String = "tool",
        summary: String = "",
        detail: String? = nil,
        tool: String? = nil,
        path: String? = nil,
        command: String? = nil,
        diff: String? = nil
    ) throws -> AgentEvent {
        var document: [String: Any] = [
            "id": id, "kind": kind, "summary": summary, "createdAt": "2026-08-30T10:00:00Z",
        ]
        if let detail { document["detail"] = detail }
        if let tool { document["tool"] = tool }
        if let path { document["path"] = path }
        if let command { document["command"] = command }
        if let diff { document["diff"] = diff }
        return try JSONDecoder().decode(
            AgentEvent.self, from: JSONSerialization.data(withJSONObject: document))
    }

    func testSummarySpeaksInVerbs() throws {
        let events = [
            try event(id: "e1", tool: "Bash", command: "bun test"),
            try event(id: "e2", tool: "Edit", path: "src/a.ts"),
            try event(id: "e3", tool: "Edit", path: "src/b.ts"),
        ]
        XCTAssertEqual(activitySummary(events), "Ran 1 command, edited 2 files")
    }

    func testSummaryCountsCreatedAndRead() throws {
        XCTAssertEqual(
            activitySummary([try event(id: "e1", tool: "Read", path: "src/a.ts")]),
            "Read 1 file")
    }

    func testSummaryFallsBackToThoughts() throws {
        XCTAssertEqual(
            activitySummary([
                try event(id: "e1", kind: "thought", summary: "Thinking", detail: "hm"),
            ]),
            "Thought once")
    }

    func testSummaryFallsBackToSteps() throws {
        XCTAssertEqual(
            activitySummary([try event(id: "e1", kind: "output", summary: "chunk")]),
            "1 step")
    }

    func testDiffStatSumsAddedAndRemovedLines() throws {
        let events = [
            try event(
                id: "e1", tool: "Edit", path: "a.ts",
                diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n+one\n+two\n-gone\n context"),
            try event(id: "e2", tool: "Edit", path: "b.ts", diff: "+three"),
        ]
        XCTAssertEqual(diffStat(events), DiffStat(added: 3, removed: 1))
    }

    func testDiffStatIsNilWithoutDiffs() throws {
        XCTAssertNil(diffStat([try event(id: "e1", tool: "Bash", command: "ls")]))
    }

    func testASearchIsASearchNotAnEdit() throws {
        let events = [
            try event(id: "e1", tool: "Grep", path: "src"),
            try event(id: "e2", tool: "Grep", path: "docs"),
            try event(id: "e3", tool: "Edit", path: "a.ts"),
        ]
        XCTAssertEqual(activitySummary(events), "Edited 1 file, searched 2 times")
    }

    func testFailedStepsAreCountedForTheHeader() throws {
        let events = [
            try event(id: "e1", kind: "error", summary: "boom"),
            try event(id: "e2", kind: "tool", summary: "ok"),
            try event(id: "e3", kind: "error", summary: "boom again"),
        ]
        XCTAssertEqual(failedSteps(events), 2)
        XCTAssertEqual(failedSteps(events.filter { $0.kind != "error" }), 0)
    }

    func testASubagentsConsecutiveWorkFoldsToOneSegmentTitledByItsTask() throws {
        func step(_ id: String, sub: String? = nil, name: String? = nil) throws -> AgentEvent {
            var document: [String: Any] = [
                "id": id, "kind": "tool", "summary": "Edit", "createdAt": "2026-08-30T10:00:0\(id)Z",
            ]
            if let sub { document["subagentId"] = sub }
            if let name { document["subagentName"] = name }
            return try JSONDecoder().decode(
                AgentEvent.self, from: JSONSerialization.data(withJSONObject: document))
        }
        let segments = activitySegments([
            try step("1"),
            try step("2", sub: "s1", name: "Search the docs"),
            try step("3", sub: "s1", name: "Search the docs"),
            try step("4"),
            try step("5", sub: "s1", name: "Search the docs"),
        ])
        XCTAssertEqual(segments.map(\.subagentId), [nil, "s1", nil, "s1"])
        XCTAssertEqual(segments[1].events.count, 2)
        XCTAssertEqual(segments[1].title, "Search the docs")
        XCTAssertEqual(segments[3].events.count, 1)
    }

    func testTheCurrentPassBeginsAtTheLastInstruction() throws {
        func chat(_ id: String, kind: String, detail: String, at: String) throws -> AgentEvent {
            try JSONDecoder().decode(
                AgentEvent.self,
                from: JSONSerialization.data(withJSONObject: [
                    "id": id, "kind": kind,
                    "summary": kind == "user" ? "Remote command: prompt" : "Edit",
                    "detail": detail, "createdAt": at,
                ]))
        }
        let events = [
            try chat("u1", kind: "user", detail: "first", at: "2026-08-30T10:00:00Z"),
            try chat("t1", kind: "tool", detail: "", at: "2026-08-30T10:01:00Z"),
            try chat("u2", kind: "user", detail: "second", at: "2026-08-30T10:02:00Z"),
            try chat("t2", kind: "tool", detail: "", at: "2026-08-30T10:03:00Z"),
        ]
        XCTAssertEqual(latestInstructionAt(events), "2026-08-30T10:02:00Z")
        XCTAssertNil(latestInstructionAt(events.filter { $0.kind == "tool" }))
    }

    func testTheNewDividerLandsOnTheFirstUnseenItemAndOnlyMidList() throws {
        func item(_ id: String, at: String) throws -> TimelineItem {
            .activity([
                try JSONDecoder().decode(
                    AgentEvent.self,
                    from: JSONSerialization.data(withJSONObject: [
                        "id": id, "kind": "tool", "summary": "Edit", "createdAt": at,
                    ])),
            ])
        }
        let items = [
            try item("a", at: "2026-08-30T10:00:00Z"),
            try item("b", at: "2026-08-30T10:05:00Z"),
            try item("c", at: "2026-08-30T10:10:00Z"),
        ]
        XCTAssertEqual(firstUnseenIndex(items, seenUpTo: "2026-08-30T10:02:00Z"), 1)
        XCTAssertNil(firstUnseenIndex(items, seenUpTo: "2026-08-30T09:00:00Z"))
        XCTAssertNil(firstUnseenIndex(items, seenUpTo: "2026-08-30T11:00:00Z"))
        XCTAssertNil(firstUnseenIndex(items, seenUpTo: nil))
    }
}