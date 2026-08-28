import SwiftUI

/// What the session changed on disk, one file at a time.
/// Mirrored from `DiffView` / `DiffFileCard` on Android.
struct DiffView: View {
    var files: [AgentFileChange]
    /// Whether the fetch has come back at all. Claiming "0 files changed" while
    /// it is still in flight states a result the screen does not have yet.
    var loaded: Bool

    @State private var allExpanded = true
    /// Bumped by the expand-all control. Each card keys its own state on this,
    /// so one press moves every card without the parent owning per-card state.
    @State private var expandRevision = 0

    private var additions: Int { files.reduce(0) { $0 + $1.additions } }
    private var deletions: Int { files.reduce(0) { $0 + $1.deletions } }

    var body: some View {
        VStack(spacing: 0) {
            header
            if files.isEmpty {
                empty
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(files) { file in
                            DiffFileCard(file: file, expandedByDefault: allExpanded, expandRevision: expandRevision)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.ink)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "plusminus")
                .font(.system(size: 14))
                .foregroundStyle(Palette.muted)
            Text(!loaded && files.isEmpty ? "Changes" : "\(files.count) \(files.count == 1 ? "file" : "files") changed")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.text.opacity(0.86))
            Spacer(minLength: 0)
            if additions > 0 {
                Text("+\(additions)")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Palette.signal)
            }
            if deletions > 0 {
                Text("\u{2212}\(deletions)")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Palette.danger)
            }
            if !files.isEmpty {
                Button {
                    allExpanded.toggle()
                    expandRevision += 1
                } label: {
                    Image(systemName: allExpanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.muted)
                        .frame(width: 40, height: 40)
                }
                .accessibilityLabel(allExpanded ? "Collapse all files" : "Expand all files")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .frame(height: 48)
        .background(Color(hex: 0x0C1014))
    }

    private var empty: some View {
        VStack(spacing: 6) {
            Image(systemName: "plusminus")
                .font(.system(size: 28))
                .foregroundStyle(Palette.muted)
                .padding(.bottom, 6)
            // Until the session's changes have been fetched, "none" is not
            // yet known.
            Text(loaded ? "No captured changes" : "Loading changes…")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.text)
            if loaded {
                Text("Edits and writes exposed by this runtime will appear here.")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Long file rewrites arrive as thousands of `+` lines; render a readable slice
/// until asked for the rest.
private let diffLineBudget = 300

private struct DiffFileCard: View {
    var file: AgentFileChange
    var expandedByDefault: Bool
    var expandRevision: Int

    @State private var expanded = true
    @State private var showAllLines = false

    private var truncated: Bool { file.lineCount > diffLineBudget && !showAllLines }

    var body: some View {
        VStack(spacing: 0) {
            head
            if expanded {
                Divider().overlay(Palette.line)
                body(for: file)
                if file.lineCount > diffLineBudget {
                    Divider().overlay(Palette.line)
                    Button {
                        showAllLines.toggle()
                    } label: {
                        Text(truncated ? "Show all \(file.lineCount) lines" : "Show first \(diffLineBudget) lines")
                            .font(.system(size: 12))
                            .foregroundStyle(Palette.blue)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 14).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .onAppear { expanded = expandedByDefault }
        .onChange(of: expandRevision) { _, _ in expanded = expandedByDefault }
    }

    private var head: some View {
        Button { expanded.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.blue)
                // The leading directories are the droppable part; the file name
                // is what a person is reading.
                Text(file.path)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Palette.text.opacity(0.9))
                    .lineLimit(1)
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if file.additions > 0 {
                    Text("+\(file.additions)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Palette.signal)
                }
                if file.deletions > 0 {
                    Text("\u{2212}\(file.deletions)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Palette.danger)
                }
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.muted)
            }
            .padding(.leading, 12)
            .padding(.trailing, 10)
            .padding(.vertical, 11)
        }
        .buttonStyle(.plain)
    }

    /// One horizontal scroller for the whole file, so every line's tint runs to
    /// the same edge. Scrolling each row separately would let two lines of the
    /// same hunk sit at different offsets.
    private func body(for file: AgentFileChange) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    switch row.content {
                    case .separator(let label):
                        Text(label)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Palette.blue)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Palette.blue.opacity(0.06))
                    case .line(let line):
                        DiffLineRow(line: line, showLineNumbers: file.hasLineNumbers)
                    }
                }
            }
            // A horizontal scroller hands children unbounded width, so a row
            // fills only its own text and each line's tint stops where its
            // characters do. Pinning the column to the viewport gives the rows
            // a real width to fill, edge to edge.
            .frame(minWidth: horizontalViewportWidth, alignment: .leading)
        }
        .textSelection(.enabled)
    }

    /// Enough that a short diff still tints the full card. The scroller grows
    /// past it for anything wider.
    private var horizontalViewportWidth: CGFloat {
        UIScreen.main.bounds.width - 48
    }

    /// The card's hunks flattened into one list, cut at the budget.
    ///
    /// Flattened before rendering rather than counted inside the view builder:
    /// a running total cannot be kept across a `ForEach`, and a per-hunk slice
    /// would let a file of five small hunks render five budgets' worth.
    private var rows: [DiffRow] {
        var result: [DiffRow] = []
        let budget = truncated ? diffLineBudget : Int.max
        for (index, hunk) in file.hunks.enumerated() {
            if result.count >= budget { break }
            if index > 0 {
                result.append(DiffRow(
                    id: "sep:\(hunk.id)",
                    content: .separator("Change \(index + 1) \u{00B7} \(messageClock(hunk.createdAt))")
                ))
            }
            for line in hunk.lines {
                if result.count >= budget { break }
                result.append(DiffRow(id: "\(hunk.id):\(line.index)", content: .line(line)))
            }
        }
        return result
    }
}

private struct DiffRow: Identifiable {
    enum Content {
        /// Where one runtime edit ends and the next begins, in a file both
        /// touched.
        case separator(String)
        case line(AgentDiffLine)
    }

    var id: String
    var content: Content
}

private struct DiffLineRow: View {
    var line: AgentDiffLine
    var showLineNumbers: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if showLineNumbers {
                Text(number.map(String.init) ?? "")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Palette.muted.opacity(0.55))
                    .frame(width: 40, alignment: .trailing)
                    .padding(.trailing, 6)
            }
            Text(marker)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(foreground)
                .frame(width: 24)
                .frame(maxHeight: .infinity)
                .background(foreground.opacity(0.08))
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(foreground)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 24)
        .background(background)
    }

    private var text: String {
        if line.kind == .header { return hunkHeaderContext(line.text) ?? line.text }
        return line.text.isEmpty ? " " : line.text
    }

    /// Deletions are positioned in the old file, everything else in the new one.
    private var number: Int? { line.kind == .deletion ? line.oldLine : line.newLine }

    private var marker: String {
        switch line.kind {
        case .addition: "+"
        case .deletion: "\u{2212}"
        default: " "
        }
    }

    private var foreground: Color {
        switch line.kind {
        case .addition: Palette.signal
        case .deletion: Palette.danger
        case .header: Palette.blue
        case .context: Palette.text.opacity(0.78)
        }
    }

    private var background: Color {
        switch line.kind {
        case .addition: Palette.signal.opacity(0.10)
        case .deletion: Palette.danger.opacity(0.10)
        case .header: Palette.blue.opacity(0.08)
        case .context: .clear
        }
    }
}

/// A conversation timestamps to the minute.
func messageClock(_ value: String) -> String {
    guard let date = Timestamps.parse(value) else { return "" }
    return date.formatted(date: .omitted, time: .shortened)
}
