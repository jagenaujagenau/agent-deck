import XCTest
@testable import AgentDeckPolicy

/// The rule every clipped surface shares — a card's preview line, a
/// notification body, a widget row, a conversation-map marker. Its Kotlin twin
/// is `MarkdownPreviewTest`, case for case, so a divergence fails on both
/// phones rather than showing up as two differently-worded banners.
final class MarkdownPreviewTests: XCTestCase {
    func testMarkdownPreviewKeepsMeaningWithoutFormattingSyntax() {
        XCTAssertEqual(
            stripMarkdownForPreview("# Plan\n\n- Read [docs](https://example.com) before **editing**"),
            "Plan Read docs before editing")
    }

    func testATableBecomesItsCells() {
        XCTAssertEqual(
            stripMarkdownForPreview("| pass | frame |\n|---|---|\n| before | 21 ms |"),
            "pass \u{00B7} frame before \u{00B7} 21 ms")
    }

    func testAFencedBlockIsNamedRatherThanQuoted() {
        XCTAssertEqual(
            stripMarkdownForPreview("Try:\n\n```kotlin\nval a = 1\n```\n\nDone."), "Try: code Done.")
    }

    func testAnUnclosedFenceDoesNotSwallowTheWordsBeforeIt() {
        XCTAssertEqual(stripMarkdownForPreview("Here it is:\n\n```sh\nnpm test"), "Here it is: code")
    }

    func testATaskListAndARuleLeaveOnlyWhatTheySaid() {
        XCTAssertEqual(
            stripMarkdownForPreview("- [x] shipped\n- [ ] pending\n\n---\n\nand then this"),
            "shipped pending and then this")
    }

    func testAnIdentifierWithUnderscoresIsNotEmphasis() {
        XCTAssertEqual(
            stripMarkdownForPreview("Check user_id_lookup before _touching_ the cache"),
            "Check user_id_lookup before touching the cache")
    }

    func testAMarkerPreviewClipsAtAWord() {
        XCTAssertEqual(markerPreview("# one two three", limit: 10), "one two…")
    }
}
