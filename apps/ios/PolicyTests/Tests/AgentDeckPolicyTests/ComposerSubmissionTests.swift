import XCTest
@testable import AgentDeckPolicy

/// What a draft becomes, mirrored from Android's AgentConversationTest.
final class ComposerSubmissionTests: XCTestCase {
    func testADraftBecomesAPromptAShellCommandOrNothing() {
        XCTAssertEqual(composerSubmission("  Fix the tests  "), "Fix the tests")
        XCTAssertNil(composerSubmission("   "))
        // A bare "!" is not a command: one phone used to send the literal
        // character as a prompt while the other sent nothing.
        XCTAssertNil(composerSubmission("!"))
        XCTAssertNil(composerSubmission("!   "))
        XCTAssertEqual(composerSubmission("!bun test"), terminalCommandInstruction("bun test"))
    }
}
