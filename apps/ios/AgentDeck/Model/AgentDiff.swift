import Foundation

/// A session's file changes, assembled from the events that carry a diff.
/// Mirrored from `apps/android/mobile/.../AgentDiff.kt`.

enum DiffLineKind { case addition, deletion, context, header }

struct AgentDiffLine: Equatable, Identifiable {
    var kind: DiffLineKind
    var text: String
    var oldLine: Int?
    var newLine: Int?
    /// Position within its hunk. Diff lines repeat verbatim all the time — two
    /// blank context lines are equal in every field — so identity is the slot.
    var index: Int = 0
    var id: Int { index }
}

struct AgentDiffHunk: Equatable, Identifiable {
    var id: String
    var createdAt: String
    var lines: [AgentDiffLine]
}

struct AgentFileChange: Equatable, Identifiable {
    var path: String
    var hunks: [AgentDiffHunk]
    var additions: Int
    var deletions: Int

    var id: String { path }

    /// Runtimes that emit bare `-`/`+` pairs carry no positions; the gutter
    /// stays off for those rather than showing a column of blanks.
    var hasLineNumbers: Bool {
        hunks.contains { $0.lines.contains { $0.oldLine != nil || $0.newLine != nil } }
    }

    var lineCount: Int { hunks.reduce(0) { $0 + $1.lines.count } }
}

func agentFileChanges(_ events: [AgentEvent]) -> [AgentFileChange] {
    var seen = Set<String>()
    let withDiffs = events
        .filter { !($0.diff ?? "").trimmed.isEmpty }
        .filter { seen.insert($0.id).inserted }
        .sorted { $0.createdAt < $1.createdAt }

    var order: [String] = []
    var byPath: [String: [AgentEvent]] = [:]
    for event in withDiffs {
        let path = (event.path ?? "").trimmed.isEmpty ? "Unknown file" : (event.path ?? "")
        if byPath[path] == nil { order.append(path) }
        byPath[path, default: []].append(event)
    }

    return order.map { path -> AgentFileChange in
        let hunks = (byPath[path] ?? []).map { event in
            AgentDiffHunk(id: event.id, createdAt: event.createdAt, lines: parseDiffLines(event.diff ?? ""))
        }
        return AgentFileChange(
            path: path,
            hunks: hunks,
            additions: hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .addition }.count },
            deletions: hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .deletion }.count }
        )
    }
    .sorted { $0.path.lowercased() < $1.path.lowercased() }
}

/// Parses one runtime-supplied diff body. Unified diffs get real old/new line
/// numbers tracked across their `@@` hunk headers; synthetic `- old` / `+ new`
/// bodies parse into the same shape without them.
func parseDiffLines(_ diff: String) -> [AgentDiffLine] {
    var oldLine: Int?
    var newLine: Int?
    var started = false
    return diff.components(separatedBy: "\n").enumerated().map { index, raw in
        func line(_ kind: DiffLineKind, _ text: String, old: Int? = nil, new: Int? = nil) -> AgentDiffLine {
            AgentDiffLine(kind: kind, text: text, oldLine: old, newLine: new, index: index)
        }
        if let range = hunkHeaderRange(raw) {
            oldLine = range.old
            newLine = range.new
            started = true
            return line(.header, raw)
        }
        // File preamble only counts as a header before the first hunk;
        // afterwards `---` is content.
        let preamble = raw.hasPrefix("diff ") || raw.hasPrefix("index ")
            || raw.hasPrefix("--- ") || raw.hasPrefix("+++ ") || raw == "---" || raw == "+++"
        if !started, preamble { return line(.header, raw) }
        if raw.hasPrefix("\\") {
            return line(.context, String(raw.dropFirst()).trimmed)
        }
        if raw.hasPrefix("+") {
            let at = newLine
            newLine = at.map { $0 + 1 }
            return line(.addition, dropMarker(raw), new: at)
        }
        if raw.hasPrefix("-") {
            let at = oldLine
            oldLine = at.map { $0 + 1 }
            return line(.deletion, dropMarker(raw), old: at)
        }
        let oldAt = oldLine
        let newAt = newLine
        oldLine = oldAt.map { $0 + 1 }
        newLine = newAt.map { $0 + 1 }
        return line(.context, raw.hasPrefix(" ") ? String(raw.dropFirst()) : raw, old: oldAt, new: newAt)
    }
}

private func dropMarker(_ raw: String) -> String {
    let body = String(raw.dropFirst())
    return body.hasPrefix(" ") ? String(body.dropFirst()) : body
}

/// `@@ -12,7 +12,9 @@` — the two starting positions, or nil for a line that
/// is not a hunk header.
private func hunkHeaderRange(_ raw: String) -> (old: Int?, new: Int?)? {
    guard raw.hasPrefix("@@") else { return nil }
    guard let regex = try? NSRegularExpression(pattern: #"^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#) else { return nil }
    let full = NSRange(raw.startIndex ..< raw.endIndex, in: raw)
    guard let match = regex.firstMatch(in: raw, range: full) else { return nil }
    func group(_ index: Int) -> Int? {
        guard let range = Range(match.range(at: index), in: raw) else { return nil }
        return Int(raw[range])
    }
    return (group(1), group(2))
}

/// The trailing context of `@@ -1,4 +1,6 @@ func render()`, shown instead of the
/// raw range markers — the function it lands in is what a person is looking for.
func hunkHeaderContext(_ text: String) -> String? {
    let parts = text.components(separatedBy: "@@")
    guard parts.count >= 3 else { return nil }
    let tail = parts.dropFirst(2).joined(separator: "@@").trimmed
    return tail.isEmpty ? nil : tail
}
