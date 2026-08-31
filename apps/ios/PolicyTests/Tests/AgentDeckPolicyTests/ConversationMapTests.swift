import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The conversation map fold, mirrored from Android's ConversationMapTest.
final class ConversationMapTests: XCTestCase {
    private func event(_ id: String, kind: String, summary: String, detail: String, at: String) throws -> AgentEvent {
        try JSONDecoder().decode(
            AgentEvent.self,
            from: JSONSerialization.data(withJSONObject: [
                "id": id, "kind": kind, "summary": summary, "detail": detail, "createdAt": at,
            ]))
    }

    func testOneMarkerPerExchangeClosedByTheReplyBeforeTheNextAsk() throws {
        let markers = conversationMarkers([
            try event("u1", kind: "user", summary: "Remote command: prompt", detail: "Fix the tests", at: "2026-08-31T10:00:00Z"),
            try event("r1", kind: "output", summary: "Response", detail: "Working on it", at: "2026-08-31T10:01:00Z"),
            try event("r2", kind: "output", summary: "Response", detail: "All green now", at: "2026-08-31T10:02:00Z"),
            try event("u2", kind: "user", summary: "Remote command: prompt", detail: "Now ship it", at: "2026-08-31T10:03:00Z"),
        ])
        XCTAssertEqual(markers.count, 2)
        XCTAssertEqual(markers[0].id, "u1")
        XCTAssertEqual(markers[0].prompt, "Fix the tests")
        XCTAssertEqual(markers[0].reply, "All green now")
        XCTAssertEqual(markers[1].id, "u2")
        XCTAssertNil(markers[1].reply)
    }

    func testMarkdownDressingIsStrippedAndCodeIsNamedNotQuoted() {
        XCTAssertEqual(
            markerPreview("Use ```ts\nconst x = 1\n``` and run `ls` in **bold**"),
            "Use code and run ls in bold")
    }

    func testALongLineClipsAtAWord() {
        let preview = markerPreview(String(repeating: "alpha ", count: 40), limit: 20)
        XCTAssertTrue(preview.hasSuffix("…"))
        XCTAssertTrue(preview.count <= 20)
    }
}
