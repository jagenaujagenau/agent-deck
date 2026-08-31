import Foundation
import XCTest
@testable import AgentDeckPolicy

/// The silence rule, mirrored from Android's SignalSilenceTest.
final class SignalSilenceTests: XCTestCase {
    private func agent(state: String, latestEventAt: String) throws -> Agent {
        let document: [String: Any] = [
            "id": "a1", "name": "S", "project": "p", "model": "m", "state": state,
            "task": "Using Edit", "tokens": 0, "costUsd": 0,
            "lastSeenAt": "2026-08-31T11:50:00Z",
            "events": [["id": "e1", "kind": "tool", "summary": "", "createdAt": latestEventAt]],
        ]
        return try JSONDecoder().decode(
            Agent.self, from: JSONSerialization.data(withJSONObject: document))
    }

    private let now = Timestamps.parse("2026-08-31T12:00:00Z")!

    func testARunningSessionMuteForMinutesSaysHowLong() throws {
        XCTAssertEqual(signalSilenceMinutes(try agent(state: "running", latestEventAt: "2026-08-31T11:50:00Z"), now: now), 10)
    }

    func testSignalStillFlowingIsNotSilence() throws {
        XCTAssertNil(signalSilenceMinutes(try agent(state: "running", latestEventAt: "2026-08-31T11:58:30Z"), now: now))
    }

    func testOnlyARunningSessionCanBeSuspiciouslyQuiet() throws {
        XCTAssertNil(signalSilenceMinutes(try agent(state: "idle", latestEventAt: "2026-08-31T11:00:00Z"), now: now))
        XCTAssertNil(signalSilenceMinutes(try agent(state: "waiting", latestEventAt: "2026-08-31T11:00:00Z"), now: now))
    }

    func testTheSilentSessionsCardSaysTheSilenceNotTheStaleTask() throws {
        XCTAssertTrue(
            agentCardActivity(try agent(state: "running", latestEventAt: "2016-08-31T11:00:00Z"))
                .hasPrefix("No signal for "))
    }
}
