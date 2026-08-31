import SwiftUI

/// The headline a card leads with: what this session is actually about, which
/// is not always its `task`.
/// Mirrored from `usefulTask` in the Android `MainActivity`.
func usefulTask(_ agent: Agent) -> String {
    let newest = { (kind: String) in
        agent.events.filter { $0.kind == kind }.max { $0.createdAt < $1.createdAt }
    }
    switch agent.state {
    case "waiting":
        if let approval = agent.pendingApproval { return approval.detail }
        if let question = agent.pendingQuestion {
            return question.question.isEmpty ? "Agent has a question" : question.question
        }
        if let question = newest("question") {
            // The summary is the question; the detail is the note explaining it.
            if !question.summary.trimmed.isEmpty, question.summary != "Question" { return question.summary }
            if let detail = question.detail?.trimmed, !detail.isEmpty { return detail }
            return "Agent has a question"
        }
        return agent.task
    case "running", "paused":
        if let objective = agent.objective?.trimmed, !objective.isEmpty { return objective }
        if let instruction = agent.events
            .filter({ $0.kind == "thought" && $0.summary == "Received instruction" })
            .max(by: { $0.createdAt < $1.createdAt })?.detail?.trimmed, !instruction.isEmpty {
            return instruction
        }
        if let message = newest("user")?.detail?.trimmed, !message.isEmpty { return message }
    case "offline":
        if let response = lastResponse(agent) { return "Last response · \(response)" }
        return "Session ended"
    case "idle":
        if ["done", "turn completed", "ready for an instruction"].contains(agent.task.lowercased()) {
            if let response = lastResponse(agent) { return "Last response · \(response)" }
            return "Turn completed"
        }
    default:
        break
    }
    if agent.task.hasSuffix(" completed") { return String(agent.task.dropLast(" completed".count)) + " finished · continuing" }
    if agent.task.hasPrefix("Using ") { return "Running " + String(agent.task.dropFirst("Using ".count)) }
    return agent.task
}

private func lastResponse(_ agent: Agent) -> String? {
    agent.events
        .filter { $0.kind == "output" && $0.summary == "Response" }
        .max { $0.createdAt < $1.createdAt }?
        .detail?.trimmed
        .nonEmpty
}

/// `Claude · orbital-api · 4f2a` ends in a short session hash. Kept as a
/// suffix on the title so two sessions in one project are told apart.
func sessionSuffix(_ agent: Agent) -> String {
    guard let fragment = agent.name.split(separator: "\u{00B7}").last else { return "" }
    let last = String(fragment).trimmed
    guard last.count == 4, last.allSatisfy(\.isHexDigit) else { return "" }
    return " \u{00B7} \(last)"
}

/// The card, in the two densities the deck uses: full for anything live or
/// waiting, compact for what has already settled.
struct AgentCard: View {
    var agent: Agent
    var state: HomeAgentState

    private var harness: Harness { agent.harness }

    var body: some View {
        if state.isCompact {
            compact
        } else {
            full
        }
    }

    // MARK: - Full

    private var full: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                HarnessMark(harness: harness, status: state.color, running: agent.state == "running", diameter: 44)
                Text(harness.label + sessionSuffix(agent))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: 6)
                // The status never truncates: "Approval requir…" is the one
                // word on the card that must survive a narrow screen.
                StatusLabel(label: state.label, color: state.color)
                    .fixedSize()
            }

            Text(usefulTask(agent))
                .font(.system(size: 14))
                .lineSpacing(4)
                .foregroundStyle(state.attention ? state.color : Palette.text.opacity(0.9))
                .lineLimit(2)
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .topLeading)

            if let activity = activityLine {
                HStack(spacing: 7) {
                    Image(systemName: state.symbol)
                        .font(.system(size: 12))
                        .foregroundStyle(state.color)
                    Text(activity)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }
                .frame(height: 18)
            }

            HStack(spacing: 7) {
                ProviderMark(model: agent.model, harness: harness)
                Text(humanizeModelId(agent.model))
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                Spacer(minLength: 3)
                Text(Timestamps.freshness(agent.lastSeenAt))
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.muted.opacity(0.8))
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.muted.opacity(0.7))
            }
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22).fill(state.attention ? Palette.surfaceRaised : Palette.surface))
        .overlay {
            if state.attention {
                RoundedRectangle(cornerRadius: 22).stroke(state.color.opacity(0.28), lineWidth: 1)
            }
        }
    }

    // MARK: - Compact

    private var compact: some View {
        HStack(spacing: 11) {
            HarnessMark(harness: harness, status: state.color, running: false, diameter: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    Text(harness.label + sessionSuffix(agent))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Text(Timestamps.freshness(agent.lastSeenAt))
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted)
                }
                Text(usefulTask(agent))
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            // The one compact card that carries a status: an unseen finish is
            // the compact shelf's only news, and it should read as news until
            // the session is opened.
            if state == .done {
                StatusLabel(label: "Done", color: Palette.blue)
                    .fixedSize()
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.muted.opacity(0.7))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18).fill(state == .done ? Palette.surfaceRaised : Palette.surface))
        .overlay {
            if state == .done {
                RoundedRectangle(cornerRadius: 18).stroke(Palette.blue.opacity(0.28), lineWidth: 1)
            }
        }
    }

    /// Nothing is reserved for absent content, and nothing restates the
    /// headline: a card that says the same thing twice has wasted the only two
    /// lines it gets.
    private var activityLine: String? {
        let activity = agentCardActivity(agent)
        return normalize(activity) == normalize(usefulTask(agent)) ? nil : activity
    }

    private func normalize(_ value: String) -> String {
        var text = value.lowercased()
        for prefix in ["running ", "using "] where text.hasPrefix(prefix) { text = String(text.dropFirst(prefix.count)) }
        for suffix in [" finished", " completed"] where text.hasSuffix(suffix) { text = String(text.dropLast(suffix.count)) }
        return text.trimmed
    }
}

struct StatusLabel: View {
    var label: String
    var color: Color

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
                .lineLimit(1)
        }
    }
}

extension HomeAgentState {
    var isCompact: Bool {
        switch self {
        case .done, .paused, .recentlyCompleted, .history: true
        default: false
        }
    }

    var symbol: String {
        switch self {
        case .approvalRequired: "checkmark.shield"
        case .question: "questionmark.circle"
        case .inputRequired: "keyboard"
        case .failed: "exclamationmark.triangle"
        case .done: "checkmark.circle"
        default: "bolt.fill"
        }
    }
}
