import Foundation

/// The shell side of a session, and how it is typed out.
/// Mirrored from `apps/android/mobile/.../AgentConversation.kt` and
/// `TerminalChrome.kt`.

/// Every event that carries a command, oldest first.
func terminalEvents(_ events: [AgentEvent]) -> [AgentEvent] {
    events
        .filter { !($0.command ?? "").trimmed.isEmpty }
        .sorted { $0.createdAt < $1.createdAt }
}

/// How fast the terminal types out a command it has just received.
///
/// A rate rather than a duration, because a one-word command and a paragraph of
/// shell should feel like the same terminal working, not the same animation
/// stretched over different lengths.
enum TerminalTypeSpeed: Int, CaseIterable {
    case off, slow, normal, fast

    var label: String {
        switch self {
        case .off: "OFF"
        case .slow: "SLOW"
        case .normal: "NORM"
        case .fast: "FAST"
        }
    }

    var charsPerSecond: Int {
        switch self {
        case .off: 0
        case .slow: 30
        case .normal: 110
        case .fast: 320
        }
    }

    /// Tapping the segment walks the list, so one control covers all four.
    var next: TerminalTypeSpeed {
        TerminalTypeSpeed(rawValue: (rawValue + 1) % TerminalTypeSpeed.allCases.count) ?? .off
    }
}

/// How long a line of this length takes at this rate, floored so a one-character
/// command still reads as having been typed rather than appearing.
func typingDuration(length: Int, charsPerSecond: Int) -> Double {
    guard charsPerSecond > 0, length > 0 else { return 0 }
    return max(Double(length) / Double(charsPerSecond), 0.016)
}

/// What a command typed into the terminal prompt actually sends.
///
/// A runtime has no shell of its own to hand this to — it has a shell *tool*,
/// and reaching it means asking in words. Fencing the command keeps the runtime
/// from rewriting it, and the fence is widened past any backticks the command
/// itself contains.
func terminalCommandInstruction(_ command: String) -> String {
    let exact = command.trimmed
    var longestRun = 0
    var run = 0
    for character in exact {
        run = character == "`" ? run + 1 : 0
        longestRun = max(longestRun, run)
    }
    let fence = String(repeating: "`", count: max(3, longestRun + 1))
    return """
    Run this exact shell command using the runtime's shell tool. Do not alter it:

    \(fence)sh
    \(exact)
    \(fence)
    """
}

/// The `/` picker's query, or nil when the caret is not in a command token.
///
/// Only a leading `/` with no whitespace after it counts: once the user types an
/// argument they are writing a message, not still choosing a command.
func slashCommandQuery(_ input: String) -> String? {
    guard input.hasPrefix("/") else { return nil }
    let token = String(input.dropFirst())
    return token.contains(where: \.isWhitespace) ? nil : token
}

/// Commands matching the query, name matches first, then description matches.
func matchSlashCommands(_ query: String, _ commands: [SlashCommand], limit: Int = 30) -> [SlashCommand] {
    let needle = query.trimmed.lowercased()
    if needle.isEmpty { return Array(commands.prefix(limit)) }
    let byName = commands.filter { $0.name.lowercased().contains(needle) }
    let named = Set(byName.map(\.name))
    let byDescription = commands.filter { command in
        !named.contains(command.name) && (command.description ?? "").lowercased().contains(needle)
    }
    let ranked = byName.sorted { first, second in
        let a = first.name.lowercased().hasPrefix(needle) ? 0 : 1
        let b = second.name.lowercased().hasPrefix(needle) ? 0 : 1
        return a < b
    }
    return Array((ranked + byDescription).prefix(limit))
}

/// What a terminal line should actually show.
///
/// A heredoc that writes a file arrives as the whole file: measured on this
/// bridge, `cat > … <<'EOF'` commands are eight thousand characters, clipped.
/// Printing that is not showing the command, it is burying the session in the
/// file's own contents — and the one fact worth reading, which file was
/// written, is on the first line and then lost.
/// Mirrored from `apps/android/mobile/.../TerminalChrome.kt`.
enum TerminalLine: Equatable {
    /// An ordinary command, shown as typed.
    case shell(String)
    /// A write to a file, shown as the act rather than the payload.
    case fileWrite(verb: String, path: String)

    var fileName: String {
        guard case .fileWrite(_, let path) = self else { return "" }
        let name = path.split(separator: "/").last.map(String.init) ?? ""
        return name.isEmpty ? path : name
    }

    /// The directory, trimmed to something that fits a phone.
    var fileParent: String {
        guard case .fileWrite(_, let path) = self, let cut = path.lastIndex(of: "/") else { return "" }
        let directory = String(path[path.startIndex ..< cut])
        return directory.count <= 34 ? directory : "\u{2026}" + String(directory.suffix(33))
    }
}

/// `cat > path`, `cat >> path` — the redirect carries whether it replaces or
/// appends. `tee path`, `tee -a path` — the flag carries it instead.
private let catWrite = try? NSRegularExpression(pattern: #"\bcat\s*(>>|>)\s*("[^"]+"|'[^']+'|[^\s<>|;&]+)"#)
private let teeWrite = try? NSRegularExpression(pattern: #"\btee\s+(-a\s+)?("[^"]+"|'[^']+'|[^\s<>|;&]+)"#)

/// Whether this looks like a path worth naming rather than a stream.
///
/// `/dev/null` and `/dev/stdout` are redirections, not edits, and calling one an
/// edit would be the same overclaiming this is meant to remove.
private func isFilePath(_ value: String) -> Bool {
    !value.trimmed.isEmpty && !value.hasPrefix("/dev/") && (value.contains("/") || value.contains("."))
}

/// How a command should be drawn: as itself, or as the file it writes.
func terminalLine(_ command: String) -> TerminalLine {
    // Only the first line: everything after it is the heredoc body.
    let head = command.components(separatedBy: "\n").first ?? ""
    let range = NSRange(head.startIndex ..< head.endIndex, in: head)

    func group(_ match: NSTextCheckingResult, _ index: Int) -> String {
        guard let range = Range(match.range(at: index), in: head) else { return "" }
        return String(head[range]).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }

    if let match = catWrite?.firstMatch(in: head, range: range) {
        let path = group(match, 2)
        if isFilePath(path) {
            return .fileWrite(verb: group(match, 1) == ">>" ? "Appending to" : "Editing", path: path)
        }
    }
    if let match = teeWrite?.firstMatch(in: head, range: range) {
        let path = group(match, 2)
        if isFilePath(path) {
            return .fileWrite(verb: group(match, 1).trimmed.isEmpty ? "Editing" : "Appending to", path: path)
        }
    }
    return .shell(command)
}
