import XCTest
@testable import AgentDeckPolicy

/// The block shapes a message arrives in. iOS rendered all of these as their
/// raw markers until the parser existed, so every case here is something the
/// phone used to show as literal text.
final class MarkdownBlockTests: XCTestCase {
    func testHeadingsAreLifted() {
        let blocks = markdownBlocks("## Findings\n\nTwo things went wrong.")
        XCTAssertEqual(blocks.first, .heading(level: 2, text: "Findings"))
        XCTAssertEqual(blocks.last, .paragraph("Two things went wrong."))
    }

    func testHashWithoutASpaceIsNotAHeading() {
        XCTAssertEqual(markdownBlocks("#4 in the queue"), [.paragraph("#4 in the queue")])
    }

    func testBulletsBecomeAList() {
        let blocks = markdownBlocks("- first\n- second\n  - nested")
        guard case let .list(ordered, items)? = blocks.single() else { return XCTFail("expected a list, got \(blocks)") }
        XCTAssertFalse(ordered)
        XCTAssertEqual(items.map(\.text), ["first", "second", "nested"])
        XCTAssertEqual(items.map(\.depth), [0, 0, 1])
    }

    func testNumberedListKeepsItsOwnNumbers() {
        let blocks = markdownBlocks("3. third\n4. fourth")
        guard case let .list(ordered, items)? = blocks.single() else { return XCTFail("expected a list, got \(blocks)") }
        XCTAssertTrue(ordered)
        XCTAssertEqual(items.map(\.number), [3, 4])
    }

    func testTaskListMarksAreRead() {
        let blocks = markdownBlocks("- [x] shipped\n- [ ] pending")
        guard case let .list(_, items)? = blocks.single() else { return XCTFail("expected a list, got \(blocks)") }
        XCTAssertEqual(items.map(\.checked), [true, false])
        XCTAssertEqual(items.map(\.text), ["shipped", "pending"])
    }

    func testWrappedListItemStaysOneItem() {
        let blocks = markdownBlocks("- a claim that runs on\n  and finishes here\n- second")
        guard case let .list(_, items)? = blocks.single() else { return XCTFail("expected a list, got \(blocks)") }
        XCTAssertEqual(items.map(\.text), ["a claim that runs on and finishes here", "second"])
    }

    func testFencedCodeKeepsItsLinesAndLanguage() {
        let blocks = markdownBlocks("Try:\n\n```swift\nlet a = 1\n\nlet b = 2\n```\n\nDone.")
        XCTAssertEqual(blocks.count, 3)
        XCTAssertEqual(blocks[1], .code(language: "swift", text: "let a = 1\n\nlet b = 2"))
        XCTAssertEqual(blocks[2], .paragraph("Done."))
    }

    func testMarkersInsideAFenceAreNotParsed() {
        let blocks = markdownBlocks("```\n# not a heading\n- not a list\n```")
        XCTAssertEqual(blocks, [.code(language: nil, text: "# not a heading\n- not a list")])
    }

    func testUnclosedFenceStillCloses() {
        let blocks = markdownBlocks("```sh\nnpm test")
        XCTAssertEqual(blocks, [.code(language: "sh", text: "npm test")])
    }

    func testQuoteBecomesItsOwnBlock() {
        let blocks = markdownBlocks("> the user asked\n> for a thing")
        XCTAssertEqual(blocks, [.quote([.paragraph("the user asked\nfor a thing")])])
    }

    func testRuleIsARuleAndAListIsNot() {
        XCTAssertEqual(markdownBlocks("a\n\n---\n\nb")[1], .rule)
        guard case .list? = markdownBlocks("* item").single() else { return XCTFail("expected a list") }
    }

    func testPlainProseIsOneParagraph() {
        XCTAssertEqual(markdownBlocks("Just a sentence."), [.paragraph("Just a sentence.")])
    }

    // MARK: - Tables, mirroring Kotlin's ResponseTableTest

    func testTableWithEmptyLeadingHeaderCell() {
        let content = """
        Measured over 30 seconds:

        | | before today | now |
        |---|---|---|
        | 27 stream updates | 27 × 596 KB | 292 KB |
        | per update | 596 KB | ~7 KB |

        That is the whole change.
        """
        let blocks = markdownBlocks(content)
        guard case let .table(headers, rows)? = blocks.tables.single() else { return XCTFail("expected one table, got \(blocks)") }
        XCTAssertEqual(headers, ["", "before today", "now"])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[1], ["per update", "596 KB", "~7 KB"])
        XCTAssertEqual(blocks.count, 3)
    }

    func testPaddedPipesAndAlignmentMarkers() {
        let content = "| Feature | State |\n| :------ | ----: |\n| Chat    | done  |"
        guard case let .table(headers, rows)? = markdownBlocks(content).tables.single() else { return XCTFail("expected a table") }
        XCTAssertEqual(headers, ["Feature", "State"])
        XCTAssertEqual(rows, [["Chat", "done"]])
    }

    func testTableEndingTheMessageNeedsNoBlankLine() {
        let content = "Summary:\n\n| a | b |\n|---|---|\n| 1 | 2 |"
        guard case let .table(_, rows)? = markdownBlocks(content).tables.single() else { return XCTFail("expected a table") }
        XCTAssertEqual(rows, [["1", "2"]])
    }

    func testRowWithTrailingEmptyCellSurvives() {
        let content = "| a | b | c |\n|---|---|---|\n| 1 | 2 | |"
        guard case let .table(_, rows)? = markdownBlocks(content).tables.single() else { return XCTFail("expected a table") }
        XCTAssertEqual(rows, [["1", "2", ""]])
    }

    func testEscapedPipesDoNotSplitARow() {
        let content = "| code | meaning |\n|---|---|\n| `a \\| b` | either |"
        guard case let .table(_, rows)? = markdownBlocks(content).tables.single() else { return XCTFail("expected a table") }
        XCTAssertEqual(rows, [["`a | b`", "either"]])
    }

    func testShortRowIsPaddedRatherThanTruncating() {
        let content = "| a | b | c |\n|---|---|---|\n| 1 | 2 |\n| 3 | 4 | 5 |"
        guard case let .table(_, rows)? = markdownBlocks(content).tables.single() else { return XCTFail("expected a table") }
        XCTAssertEqual(rows, [["1", "2", ""], ["3", "4", "5"]])
    }

    func testProseAfterATableIsNotSwallowed() {
        let content = "| a | b |\n|---|---|\n| 1 | 2 |\n\nAnd then some prose."
        let blocks = markdownBlocks(content)
        XCTAssertEqual(blocks.tables.count, 1)
        XCTAssertEqual(blocks.last, .paragraph("And then some prose."))
    }

    func testFlattenedTableIsRepaired() {
        let content = "Results: | a | b | |---|---| | 1 | 2 |"
        let blocks = markdownBlocks(content)
        guard case let .table(headers, rows)? = blocks.tables.single() else { return XCTFail("expected a table, got \(blocks)") }
        XCTAssertEqual(headers, ["a", "b"])
        XCTAssertEqual(rows, [["1", "2"]])
    }
}

private extension Array where Element == MarkdownBlock {
    var tables: [MarkdownBlock] {
        filter { if case .table = $0 { return true } else { return false } }
    }

    func single() -> MarkdownBlock? { count == 1 ? first : nil }
}
