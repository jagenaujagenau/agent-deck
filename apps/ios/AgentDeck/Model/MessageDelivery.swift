import Foundation

/// What actually happens to a message after the bridge accepts it.
///
/// Accepting a message and delivering it are different things. A hook cannot
/// type into a running session, so a message is handed over at a turn
/// boundary: the Stop hook at the end of a turn, or the next prompt the
/// person submits in the terminal. A session that is not running a turn has
/// neither until someone goes back to it, and saying nothing in that case
/// reads as the message having been sent.
///
/// Mirrored from Android's `MessageDelivery.kt` — the enum is the domain
/// concept; it used to exist only in Kotlin while this app kept the same
/// rule as a private method on a view, where no test could reach it.
enum MessageDelivery {
    /// A turn is running; it will be handed over when that turn ends.
    case atEndOfTurn

    /// Nothing is running, so it waits for whatever the session does next.
    case whenSessionResumes

    /// The session has stopped reporting; nothing is listening for it.
    case unreachable

    static func of(agentState: String) -> MessageDelivery {
        switch agentState {
        case "running": .atEndOfTurn
        case "offline": .unreachable
        // idle, waiting, paused and anything a newer runtime reports: no turn
        // is in flight, so there is no boundary to deliver at until the
        // session moves.
        default: .whenSessionResumes
        }
    }

    /// How that reads on the composer, or nil when it needs no explanation.
    var notice: String? {
        switch self {
        // A turn is running and will end on its own — the normal case needs
        // no commentary.
        case .atEndOfTurn: nil
        case .whenSessionResumes: "Queued · delivers at the next turn"
        case .unreachable: "Queued · session is offline"
        }
    }
}
