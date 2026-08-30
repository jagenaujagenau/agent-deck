import XCTest
@testable import AgentDeckPolicy

/// Mirrors Android's MessageDeliveryTest: the same rule, now reachable by a
/// test on this platform too instead of living inside a view.
final class MessageDeliveryTests: XCTestCase {
    func testARunningTurnDeliversOnItsOwnAndNeedsNoCommentary() {
        XCTAssertEqual(MessageDelivery.of(agentState: "running"), .atEndOfTurn)
        XCTAssertNil(MessageDelivery.of(agentState: "running").notice)
    }

    func testARestingSessionQueuesUntilItMoves() {
        for state in ["idle", "waiting", "paused", "someday-state"] {
            XCTAssertEqual(MessageDelivery.of(agentState: state), .whenSessionResumes, state)
        }
        XCTAssertEqual(
            MessageDelivery.of(agentState: "idle").notice,
            "Queued · delivers at the next turn"
        )
    }

    func testAnOfflineSessionSaysNothingIsListening() {
        XCTAssertEqual(MessageDelivery.of(agentState: "offline"), .unreachable)
        XCTAssertEqual(
            MessageDelivery.of(agentState: "offline").notice,
            "Queued · session is offline"
        )
    }
}
