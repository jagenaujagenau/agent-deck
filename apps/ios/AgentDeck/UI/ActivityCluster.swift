import SwiftUI

/// A run of work between words, folded to one quiet sentence.
///
/// Collapsed, it says what the run amounted to — "Ran 11 commands, edited
/// 2 files", with the diff's own +/− beside it — because the words around it
/// are what a conversation is for. Tapping the sentence opens the steps as a
/// titled sheet, each step one verb-led line, each openable where there is a
/// command, a diff, or words behind it. The live run of a working session
/// keeps its last few steps inline, so the work is watchable as it happens
/// without anyone asking.
struct ActivityClusterView: View {
    var events: [AgentEvent]
    var live: Bool
    var onOpenSteps: ([AgentEvent]) -> Void
    var onOpen: (AgentEvent) -> Void

    private var tail: [AgentEvent] { live ? Array(events.suffix(3)) : [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                onOpenSteps(events)
            } label: {
                HStack(spacing: 0) {
                    Image(systemName: "bolt")
                        .font(.system(size: 12))
                    Text(activitySummary(events))
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .padding(.leading, 7)
                    if let stat = diffStat(events) {
                        DiffStatLabel(stat: stat)
                            .padding(.leading, 6)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.muted.opacity(0.7))
                        .padding(.leading, 4)
                }
                .foregroundStyle(Palette.muted)
                .padding(.horizontal, 6)
                .padding(.vertical, 5)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open steps")
            if !tail.isEmpty {
                HStack(alignment: .top, spacing: 10) {
                    Rectangle()
                        .fill(Palette.line)
                        .frame(width: 1)
                    VStack(alignment: .leading, spacing: 0) {
                        if events.count > tail.count {
                            Text("\(events.count - tail.count) earlier steps")
                                .font(.system(size: 11))
                                .foregroundStyle(Palette.muted.opacity(0.6))
                                .padding(.vertical, 3)
                        }
                        ForEach(tail) { event in
                            ActivityRowView(event: event, onOpen: onOpen)
                        }
                    }
                }
                .padding(.leading, 12)
            }
        }
        .padding(.trailing, 40)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `+190 −11`, in the diff's own colours.
struct DiffStatLabel: View {
    var stat: DiffStat

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(stat.added)")
                .foregroundStyle(Palette.signal)
            Text("−\(stat.removed)")
                .foregroundStyle(Palette.danger.opacity(0.9))
        }
        .font(.system(size: 11, weight: .semibold))
    }
}

/// Every step of one run, under the sentence that summarised it.
struct StepsSheet: View {
    var events: [AgentEvent]
    var onOpen: (AgentEvent) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(activitySummary(events))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.text)
                Spacer()
                if let stat = diffStat(events) {
                    DiffStatLabel(stat: stat)
                }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(events) { event in
                        ActivityRowView(event: event, onOpen: onOpen)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.surface)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// One step, said as its verb: Ran, Edited, Created, Read — or the thought itself.
struct ActivityRowView: View {
    var event: AgentEvent
    var onOpen: (AgentEvent) -> Void

    private var openable: Bool {
        !(event.command ?? "").isEmpty || !(event.diff ?? "").isEmpty || !(event.detail ?? "").trimmed.isEmpty
    }

    private var failed: Bool { event.kind == "error" }

    private var command: String? {
        (event.command ?? "")
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first { !String($0).trimmed.isEmpty }
            .map { String($0).trimmed }
    }

    private var fileName: String? {
        event.path?.nonEmpty.map { ($0 as NSString).lastPathComponent }
    }

    private var verb: String? {
        if command != nil { return "Ran" }
        guard fileName != nil else { return nil }
        if event.tool == "Write" { return "Created" }
        if event.tool == "Read" { return "Read" }
        return "Edited"
    }

    private var icon: String {
        if event.kind == "thought" { return "brain" }
        if failed || event.kind == "warning" { return "exclamationmark.triangle" }
        switch verb {
        case "Ran": return "terminal"
        case "Created": return "doc.badge.plus"
        case "Read": return "eye"
        case "Edited": return "pencil"
        default: return "wrench.and.screwdriver"
        }
    }

    /// A thought's first words are the row; everything else leads with what it did.
    private var line: String {
        if event.kind == "thought" {
            let first = (event.detail ?? "")
                .split(separator: "\n", omittingEmptySubsequences: true)
                .first
                .map { String($0).trimmed }
            return first?.nonEmpty ?? event.summary
        }
        return event.summary
    }

    var body: some View {
        Button {
            if openable { onOpen(event) }
        } label: {
            HStack(spacing: 0) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(failed ? Palette.danger : Palette.muted.opacity(0.8))
                if let verb {
                    Text(verb)
                        .font(.system(size: 12))
                        .foregroundStyle(failed ? Palette.danger : Palette.text.opacity(0.72))
                        .padding(.leading, 8)
                    Text(command ?? fileName ?? "")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(failed ? Palette.danger : Palette.muted)
                        .lineLimit(1)
                        .padding(.leading, 6)
                    if fileName != nil, event.diff?.nonEmpty != nil, let stat = diffStat([event]) {
                        DiffStatLabel(stat: stat)
                            .padding(.leading, 6)
                    }
                } else {
                    Text(line)
                        .font(.system(size: 12))
                        .italic(event.kind == "thought")
                        .foregroundStyle(failed ? Palette.danger : Palette.text.opacity(0.72))
                        .lineLimit(1)
                        .padding(.leading, 8)
                }
                if openable {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9))
                        .foregroundStyle(Palette.muted.opacity(0.55))
                        .padding(.leading, 5)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .disabled(!openable)
    }
}

/// The agent is typing — three quiet dots and what it is on, messaging's own
/// idiom for "working".
struct WorkingIndicatorView: View {
    var task: String
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0 ..< 3) { index in
                Circle()
                    .fill(Palette.signal.opacity(pulse ? 1 : 0.25))
                    .frame(width: 6, height: 6)
                    .animation(
                        .easeInOut(duration: 0.7)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.16),
                        value: pulse
                    )
            }
            Text(task)
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
                .padding(.leading, 7)
        }
        .padding(.leading, 6)
        .padding(.top, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { pulse = true }
    }
}

/// One step, in full: its command, its words, its diff — depth without
/// leaving the conversation.
struct ActivityDetailSheet: View {
    var event: AgentEvent

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(event.tool ?? event.summary)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.text)
                    Spacer()
                    Text(Timestamps.freshness(event.createdAt))
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted)
                }
                if let tool = event.tool, event.summary != tool {
                    Text(event.summary)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                }
                if let command = event.command?.nonEmpty {
                    monospaceBlock(command, tint: Palette.text.opacity(0.92))
                }
                if let detail = event.detail?.trimmed.nonEmpty {
                    if event.command != nil {
                        monospaceBlock(detail, tint: Palette.muted)
                    } else {
                        Text(detail)
                            .font(.system(size: 14))
                            .lineSpacing(4)
                            .foregroundStyle(Palette.text.opacity(0.88))
                    }
                }
                if let diff = event.diff?.nonEmpty {
                    diffBlock(diff)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .background(Palette.surface)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func monospaceBlock(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.system(size: 12, design: .monospaced))
            .lineSpacing(3)
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(Palette.ink))
    }

    private func diffBlock(_ diff: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                Text(String(line))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(diffColor(String(line)))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Palette.ink))
    }

    private func diffColor(_ line: String) -> Color {
        if line.hasPrefix("+") { return Palette.signal }
        if line.hasPrefix("-") { return Palette.danger.opacity(0.9) }
        if line.hasPrefix("@@") { return Palette.blue }
        return Palette.muted
    }
}
