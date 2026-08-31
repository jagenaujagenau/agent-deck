import SwiftUI

/// The composer, owning its own keystrokes.
///
/// The draft used to be state on the session view, which made every typed
/// character re-evaluate the whole screen — refolding the conversation,
/// the markers, and the subagent runs per keystroke, which is exactly the
/// lag a thumb feels. Everything that reads or writes the draft lives here
/// now, so typing invalidates this view and nothing else. `busy` and
/// `failure` stay the session's, shared with the approval and question
/// cards, and arrive as bindings.
struct SessionComposer: View {
    var agentId: String
    var agent: Agent
    var lensed: Bool
    @Binding var busy: Bool
    @Binding var failure: String?
    /// Speaking rejoins the live edge after reading history.
    var onSpoke: () -> Void

    @Environment(DeckStore.self) private var store
    @State private var draft = ""
    /// The bridge's own sentence about why a message was refused: the session
    /// is blocked on an approval or question. Held separately from `failure`
    /// because it is answered with a choice, not a failure line — and the
    /// draft is kept for whichever way that choice goes.
    @State private var blockedNotice: String?
    @FocusState private var composerFocused: Bool

    private var slashMatches: [SlashCommand] {
        guard let query = slashCommandQuery(draft) else { return [] }
        return matchSlashCommands(query, store.slashCommands[agentId] ?? [])
    }

    var body: some View {
        if let action = remoteMessageAction(state: agent.state, capabilities: agent.capabilities) {
            VStack(spacing: 6) {
                if !slashMatches.isEmpty {
                    SlashCommandPicker(matches: slashMatches) { draft = "/\($0.name) " }
                } else if slashCommandQuery(draft) != nil, (store.slashCommands[agentId] ?? []).isEmpty {
                    Text("No commands reported by this runtime.")
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                }
                if let blockedNotice {
                    blockedBanner(agent, detail: blockedNotice)
                }
                // The dock says "queued" better than the notice does, and
                // adds the taking-back; the notice only speaks when the dock
                // has nothing.
                if let notice = deliveryNotice(agent), (store.queuedMessages[agentId] ?? []).isEmpty {
                    Text(notice)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(Palette.surfaceRaised))
                        .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
                }
                if let queued = store.queuedMessages[agentId], !queued.isEmpty {
                    QueuedMessageDock(
                        queued: queued,
                        onEdit: { command in
                            Task { await store.cancelQueued(agentId: agentId, commandId: command.id) }
                            draft = command.value ?? ""
                        },
                        onCancel: { command in
                            Task { await store.cancelQueued(agentId: agentId, commandId: command.id) }
                        }
                    )
                }
                HStack(spacing: 6) {
                    // The slash button lives inside the pill because it acts on
                    // what is being typed, not on the session.
                    Button {
                        if !draft.hasPrefix("/") { draft = "/" + draft }
                    } label: {
                        Image(systemName: "bolt")
                            .font(.system(size: 16))
                            .foregroundStyle(draft.hasPrefix("/") ? Palette.signal : Palette.muted)
                            .frame(width: 38, height: 38)
                    }
                    .accessibilityLabel("Slash command")
                    .padding(.leading, 4)

                    TextField(
                        "",
                        text: $draft,
                        prompt: Text(composerPlaceholder(action: action))
                            .foregroundStyle(Palette.muted),
                        axis: .vertical
                    )
                    .lineLimit(1 ... 4)
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.text)
                    .tint(Palette.signal)
                    .focused($composerFocused)
                    .padding(.leading, 2)
                    .padding(.vertical, 13)

                    Button {
                        Task { await send(action: action) }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Palette.ink)
                            .frame(width: 38, height: 38)
                            .background(Circle().fill(Palette.signal))
                    }
                    .disabled(draft.trimmed.isEmpty || busy)
                    .opacity(draft.trimmed.isEmpty || busy ? 0.4 : 1)
                    .accessibilityLabel("Send")
                    .padding(.trailing, 5)
                }
                .frame(minHeight: 52)
                .background(Capsule().fill(Palette.surfaceRaised))
                .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        } else {
            Text("This runtime does not accept remote messages.")
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
                .padding(16)
        }
    }

    /// Under a lens the field is still the session's: a subagent has no inbox,
    /// so the placeholder names where the message actually goes.
    private func composerPlaceholder(action: String) -> String {
        if lensed { return "Message the session…" }
        return action == "steer" ? "Reply or steer…  / commands  ! shell" : "Message agent…  / commands  ! shell"
    }

    /// A message to a session that is not on a turn will not be seen until it
    /// takes one. Saying so up front is the difference between a queue and a
    /// message that seems to have vanished.
    private func deliveryNotice(_ agent: Agent) -> String? {
        MessageDelivery.of(agentState: agent.state).notice
    }

    /// The bridge refused to deliver over a pending approval or question. The
    /// draft is deliberately still in the field: the choice offered is between
    /// answering the card in Chat first and sending this exact message anyway.
    private func blockedBanner(_ agent: Agent, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: agent.pendingApproval != nil ? "checkmark.shield" : "questionmark.circle")
                    .font(.system(size: 14))
                Text(detail.isEmpty ? "This session is waiting on an answer first." : detail)
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                // The pending card is already on this screen, just above the
                // composer; dismissing the notice returns the eye to it.
                Button {
                    blockedNotice = nil
                } label: {
                    Text(agent.pendingApproval != nil ? "Review the approval" : "Answer the question")
                        .font(.system(size: 12, weight: .semibold))
                }
                Spacer(minLength: 0)
                Button {
                    Task { await send(action: remoteMessageAction(state: agent.state, capabilities: agent.capabilities) ?? "prompt", force: true) }
                } label: {
                    Text("Send anyway")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.text)
                }
                .disabled(busy)
            }
        }
        .foregroundStyle(Palette.amber)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Palette.amber.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.amber.opacity(0.22), lineWidth: 1))
    }

    private func send(action: String, force: Bool = false) async {
        var message = draft.trimmed
        guard !message.isEmpty else { return }
        onSpoke()
        // `!` is the terminal living in the composer: the rest of the line
        // goes to the runtime as an exact shell command.
        if message.hasPrefix("!") {
            let command = String(message.dropFirst()).trimmed
            guard !command.isEmpty else { return }
            message = terminalCommandInstruction(command)
        }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await store.control(agentId: agentId, action: action, value: message, force: force)
            draft = ""
            blockedNotice = nil
            await store.loadQueued(agentId: agentId)
        } catch {
            let bridgeError = BridgeError.from(error)
            // The one refusal that keeps the draft and asks a question instead
            // of reporting a failure. Everything else lands exactly where it
            // always did.
            if case let .agentBlocked(detail) = bridgeError {
                blockedNotice = detail
            } else {
                failure = bridgeError.localizedDescription
            }
        }
    }
}
