import Foundation

/// A refused credential and an absent bridge are different problems with
/// different fixes, so they are different values — never one "connection
/// failed" that leaves a person guessing which of the two to go and change.
enum BridgeError: LocalizedError, Equatable {
    /// The bridge answered, and said no. Pairing again is the fix.
    case unauthorized
    /// Nothing answered at this address.
    case unreachable(String)
    /// It refused to deliver a message because the session is blocked on an
    /// approval or question. Not a failure of the network or the credential —
    /// the bridge is protecting the thing the session is waiting on, and its
    /// detail sentence says what that is. Sending again with `force` is the
    /// deliberate way past it.
    case agentBlocked(String)
    /// It answered, with something else wrong.
    case http(Int, String?)
    /// It answered with a body this app could not read.
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            "The bridge refused this credential."
        case let .unreachable(detail):
            "No bridge answered at that address. \(detail)"
        case let .agentBlocked(detail):
            detail.isEmpty ? "The agent is blocked on something that needs an answer first." : detail
        case let .http(status, message):
            message ?? "The bridge returned \(status)."
        case let .malformed(detail):
            "The bridge sent something this app could not read. \(detail)"
        }
    }

    /// The headline the empty state leads with. Four failures, four names:
    /// "connection failed" for all of them would be the same lie four times.
    var title: String {
        switch self {
        case .unauthorized: "This device isn't paired"
        case .unreachable: "Bridge out of range"
        case .agentBlocked: "Waiting on an answer"
        case .http: "The bridge refused the request"
        case .malformed: "Unreadable response"
        }
    }

    /// What to do about it, in one line, under the message.
    var remedy: String? {
        switch self {
        case .unauthorized:
            "Pair again with a fresh code from the bridge."
        case .unreachable:
            "Check the address, and that you are on the same tailnet."
        case .agentBlocked:
            "Answer what it is waiting on, or send anyway."
        case .http:
            nil
        case .malformed:
            "This app and the bridge may be different versions." 
        }
    }

    static func from(_ error: Error) -> BridgeError {
        if let bridge = error as? BridgeError { return bridge }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
                 .notConnectedToInternet, .timedOut, .dnsLookupFailed, .secureConnectionFailed,
                 .cannotLoadFromNetwork, .internationalRoamingOff, .dataNotAllowed:
                return .unreachable(urlError.localizedDescription)
            case .userAuthenticationRequired:
                return .unauthorized
            default:
                return .unreachable(urlError.localizedDescription)
            }
        }
        if error is DecodingError { return .malformed(String(describing: error)) }
        return .unreachable(error.localizedDescription)
    }
}
