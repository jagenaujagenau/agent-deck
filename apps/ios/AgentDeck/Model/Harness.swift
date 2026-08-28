import Foundation

/// Which coding agent a session is running under.
///
/// Read from the wire's `runtime` field when the bridge sends one, because
/// that is the adapter's own word for itself. The id-prefix and display-name
/// reads are the fallback for snapshots from an older bridge, which had no
/// such field — and for Pi, whose id carries no prefix at all.
enum Harness: String, CaseIterable {
    case claude, codex, opencode, gemini, pi, managed, unknown

    /// The runtime's own mark where there is one, and a monogram where there is
    /// not. `asset` is nil rather than a stand-in image so a surface can tell
    /// the difference and fall back to `mark` instead of drawing a blank.
    var mark: String {
        switch self {
        case .claude: "CC"
        case .codex: "CX"
        case .opencode: "OC"
        case .gemini: "GM"
        // Pi ships no mark that could be used here, so its own initial stands in.
        case .pi: "π"
        case .managed: "MC"
        case .unknown: "··"
        }
    }

    var label: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .opencode: "OpenCode"
        case .gemini: "Gemini CLI"
        case .pi: "Pi"
        case .managed: "Managed Claude"
        case .unknown: "Agent"
        }
    }

    /// nil where the runtime ships no mark, so a surface can tell the
    /// difference and fall back to `mark` instead of drawing a blank.
    var hasArtwork: Bool {
        switch self {
        // A bridge-hosted Claude session is still a Claude session.
        case .claude, .managed, .codex, .opencode: true
        case .gemini, .pi, .unknown: false
        }
    }

    static func of(agentId: String, name: String, runtime: String? = nil) -> Harness {
        // A bridge-hosted session is still its runtime underneath, but it is
        // the bridge's, and the deck says so — the id decides before the word.
        if agentId.hasPrefix("managed-") { return .managed }
        switch runtime {
        case "claude": return .claude
        case "codex": return .codex
        case "opencode": return .opencode
        case "gemini": return .gemini
        case "pi": return .pi
        default: break
        }
        if agentId.hasPrefix("claude-") { return .claude }
        if agentId.hasPrefix("codex-") { return .codex }
        if agentId.hasPrefix("opencode-") { return .opencode }
        if agentId.hasPrefix("gemini-") { return .gemini }
        // Pi names its sessions from the runtime's own id, which carries no
        // prefix, so the display name is the only thing left to read.
        if name.hasPrefix("Pi ") || name.hasPrefix("Pi·") { return .pi }
        return .unknown
    }
}

extension Agent {
    var harness: Harness { Harness.of(agentId: id, name: name, runtime: runtime) }
}
