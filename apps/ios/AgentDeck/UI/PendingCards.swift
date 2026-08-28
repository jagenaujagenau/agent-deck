import SwiftUI

/// A blocked tool call, with the two answers that release it.
///
/// Amber, because this is the one thing on the deck that is genuinely waiting
/// on a person. Approve is filled and Reject is not: the bridge already knows
/// this is a decision, and the visual weight should not argue for either.
struct ApprovalCard: View {
    @Environment(DeckStore.self) private var store
    var agent: Agent
    var approval: PendingApproval
    @Binding var busy: Bool
    @Binding var failure: String?

    private var answerable: Bool {
        supportsCapability(agent.capabilities, "approve") && supportsCapability(agent.capabilities, "reject")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.shield")
                    .font(.system(size: 17))
                    .foregroundStyle(Palette.amber)
                Text("Approval required")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.amber)
                Spacer(minLength: 0)
                if let left = Timestamps.remaining(until: approval.expiresAt) {
                    Text(left)
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted)
                }
            }

            Text(approval.tool)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(Palette.muted)

            Text(approval.detail)
                .font(.system(size: 14, design: .monospaced))
                .lineSpacing(4)
                .foregroundStyle(Palette.text.opacity(0.92))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 10) {
                Button { Task { await answer("approve") } } label: {
                    Label("Approve", systemImage: "checkmark")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.amber)
                .foregroundStyle(Palette.ink)

                Button { Task { await answer("reject") } } label: {
                    Text("Reject")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.bordered)
                .tint(Palette.muted)
            }
            .disabled(busy || !answerable)
            .opacity(busy || !answerable ? 0.5 : 1)

            if !answerable {
                Text("This runtime does not accept remote approvals — answer in the host terminal.")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18).fill(Palette.amber.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Palette.amber.opacity(0.24), lineWidth: 1))
    }

    private func answer(_ action: String) async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await store.control(agentId: agent.id, action: action)
            UINotificationFeedback.success()
        } catch {
            failure = BridgeError.from(error).localizedDescription
        }
    }
}

/// A question with the runtime's own options. Answering picks one of them
/// verbatim: the runtime matches on the text it offered, so paraphrasing it
/// here would be an answer it does not recognise.
struct QuestionCard: View {
    @Environment(DeckStore.self) private var store
    var agent: Agent
    var question: PendingQuestion
    @Binding var busy: Bool
    @Binding var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 18))
                    .foregroundStyle(Palette.amber)
                Text("Agent question")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.amber)
                Spacer(minLength: 0)
                if let left = Timestamps.remaining(until: question.expiresAt) {
                    Text(left)
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted)
                }
            }

            Text(prompt)
                .font(.system(size: 15))
                .lineSpacing(5)
                .foregroundStyle(Palette.text)
                .frame(maxWidth: .infinity, alignment: .leading)

            ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                Button { Task { await answer(option) } } label: {
                    HStack(spacing: 10) {
                        Text("\(index + 1)")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Palette.amber)
                        Text(option)
                            .font(.system(size: 14))
                            .foregroundStyle(Palette.text.opacity(0.9))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Palette.surface))
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .opacity(busy ? 0.5 : 1)
            }

            Text(question.options.isEmpty
                ? "This question has no preset options — answer from the host terminal."
                : "Choose an option to continue this session.")
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18).fill(Palette.amber.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Palette.amber.opacity(0.24), lineWidth: 1))
    }

    private var prompt: String {
        question.question.isEmpty ? "Agent has a question" : question.question
    }

    private func answer(_ option: String) async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await store.answer(agentId: agent.id, requestId: question.id, question: prompt, answer: option)
            UINotificationFeedback.success()
        } catch {
            failure = BridgeError.from(error).localizedDescription
        }
    }
}

#if canImport(UIKit)
import UIKit

enum UINotificationFeedback {
    @MainActor static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}
#endif
