import SwiftUI

/// One session: what was said, and whatever it is waiting on.
///
/// The agent is re-read from the live snapshot every frame rather than captured
/// at push time, so an approval answered here disappears here.
struct SessionView: View {
    @Environment(DeckStore.self) private var store
    var agentId: String

    @State private var history: [AgentEvent] = []
    @State private var loadedHistory = false
    @State private var busy = false
    @State private var failure: String?
    @State private var draft = ""
    /// The bridge's own sentence about why a message was refused: the session
    /// is blocked on an approval or question. Held separately from `failure`
    /// because it is answered with a choice, not a failure line — and the
    /// draft is kept for whichever way that choice goes.
    @State private var blockedNotice: String?
    /// Which subagent is being read, or the whole session when nil. A session
    /// that farms work out to three subagents reported their tool calls mixed
    /// into its own, so "what is it doing" had no answer smaller than all of it.
    @State private var lens: String?
    @State private var lensPickerOpen = false
    /// Which of the four faces of a session is being read.
    @State private var mode: SessionTab = .chat
    /// Opening a session is a request to read it, not to write to it. Switching
    /// *to* a typing surface is the deliberate act, so only that arms the focus
    /// — otherwise the keyboard covers the lower half of a conversation nobody
    /// has seen yet.
    @State private var tabChosen = false
    @FocusState private var composerFocused: Bool
    /// The live-window signature the fetched history was current for.
    @State private var fetchedActivity = ""

    private let refetchTick = Timer.publish(every: 20, on: .main, in: .common).autoconnect()

    private var agent: Agent? { store.agent(id: agentId) ?? store.allAgents.first { $0.id == agentId } }

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            if let agent {
                let runs = subagentRuns(sessionEvents(agent))
                VStack(spacing: 0) {
                    // Only worth a banner from a tab that cannot see the thing.
                    // On Chat the approval card is already on screen, and
                    // "Review in Chat" would point at itself.
                    if wantsPerson(agent), mode != .chat { attentionBanner(agent) }
                    SessionTabBar(
                        mode: $mode,
                        tabChosen: $tabChosen,
                        attention: wantsPerson(agent),
                        reasoning: reasoning(for: agent).count,
                        changes: fileChanges.count,
                        terminal: shell(for: agent).count
                    )
                    tab(for: agent)
                }
                .sheet(isPresented: $lensPickerOpen) {
                    SubagentPicker(runs: runs, selected: $lens)
                }
                // A subagent that has left the retained window is no longer a lens.
                .onChange(of: runs) { _, current in
                    if let lens, !current.contains(where: { $0.id == lens }) { self.lens = nil }
                }
            } else {
                // The session left the snapshot while it was open. Saying so is
                // better than an empty transcript that looks like a load failure.
                VStack(spacing: 8) {
                    Text("Session gone")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Palette.text)
                    Text("The bridge no longer reports this session.")
                        .font(.system(size: 13))
                        .foregroundStyle(Palette.muted)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .toolbarBackground(Palette.ink, for: .navigationBar)
        .task(id: agentId) {
            // Opening this view is the one act that counts as *seeing* the
            // session; the store keeps the mark moving for as long as it
            // stays open.
            store.beginViewing(agentId: agentId)
            await store.loadSlashCommands(agentId: agentId)
            await refetch()
        }
        .onDisappear { store.endViewing(agentId: agentId) }
        // Live events merge over the fetched history, so a refetch only recovers
        // what has aged out of the snapshot's window since — and that window is
        // two dozen events, so a busy session loses a command a minute without
        // this. Keying it on event count would refetch the whole history on
        // every tool call; polling blindly would refetch it for idle sessions
        // that cannot have changed. So: tick slowly, and only spend the fetch
        // when the live window actually moved.
        .onReceive(refetchTick) { _ in
            guard liveActivity != fetchedActivity else { return }
            Task { await refetch() }
        }
    }

    /// A cheap signature of the live window. It moves when the runtime does
    /// something and does not move when it is idle, which is the whole test the
    /// refetch needs.
    private var liveActivity: String {
        guard let agent else { return "" }
        return "\(agent.events.count):\(agent.events.first?.id ?? "")"
    }

    private func refetch() async {
        fetchedActivity = liveActivity
        await loadHistory()
        await store.loadChanges(agentId: agentId)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            if let agent {
                let runs = subagentRuns(sessionEvents(agent))
                let active = runs.first { $0.id == lens }
                Button {
                    lensPickerOpen = true
                } label: {
                    HStack(spacing: 9) {
                        HarnessMark(
                            harness: agent.harness,
                            status: sessionStateColor(agent.state),
                            running: agent.state == "running",
                            diameter: 30
                        )
                        VStack(alignment: .leading, spacing: 1) {
                            Text(active?.title ?? agent.project)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(active != nil ? Palette.blue : Palette.text)
                                .lineLimit(1)
                            if let active {
                                // Under a lens the state word belongs to the
                                // subagent, not the session.
                                Text("\(active.finished ? "done" : "running") \u{00B7} \(agent.project)")
                                    .font(.system(size: 11))
                                    .foregroundStyle(active.finished ? Palette.muted : Palette.blue)
                                    .lineLimit(1)
                            } else {
                                Text(agentCardActivity(agent))
                                    .font(.system(size: 11))
                                    .foregroundStyle(sessionStateColor(agent.state))
                                    .lineLimit(1)
                            }
                        }
                        if !runs.isEmpty {
                            // How many, and that there is something to open.
                            HStack(spacing: 3) {
                                Image(systemName: "point.topleft.down.to.point.bottomright.curvepath")
                                    .font(.system(size: 12))
                                Text("\(runs.count)")
                                    .font(.system(size: 12, weight: .semibold))
                            }
                            .foregroundStyle(Palette.blue)
                        }
                    }
                }
                .buttonStyle(.plain)
                // A control that opens an empty list is worse than no control.
                .disabled(runs.isEmpty)
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            if let agent {
                let archived = store.isArchived(agent)
                Button {
                    if archived { store.restore(agent) } else { store.archive(agent) }
                } label: {
                    Image(systemName: archived ? "tray.and.arrow.up" : "archivebox")
                        .font(.system(size: 15))
                        .foregroundStyle(Palette.muted)
                }
                .accessibilityLabel(archived ? "Restore session" : "Archive session")
            }
        }
    }

    // MARK: - Tabs

    /// The tabs are handed a session narrowed to one subagent's work, so chat,
    /// reasoning, changes and terminal all read as that subagent without a
    /// second set of screens existing.
    @ViewBuilder private func tab(for agent: Agent) -> some View {
        switch mode {
        case .chat:
            conversation(for: agent)
            // The composer stays under a lens. A subagent has no inbox — it is
            // spawned with a prompt and returns once — so a message can only go
            // to the session. Hiding the field said "you cannot reply" instead,
            // which is a bigger lie than the one it was avoiding; the
            // placeholder names where the message goes.
            composer(for: agent)
        case .reasoning:
            ReasoningView(events: reasoning(for: agent))
        case .changes:
            DiffView(files: fileChanges, loaded: store.changesLoaded(agentId: agentId))
        case .terminal:
            // The terminal is scrollback first: the keyboard rises only when
            // the prompt itself is tapped, never on opening the tab.
            TerminalView(
                agent: lensedAgent(agent),
                events: shell(for: agent),
                busy: $busy,
                failure: $failure
            )
        }
    }

    /// The session with its events narrowed to the current lens, so a view that
    /// reads `agent.events` for itself sees the same slice the tab does.
    private func lensedAgent(_ agent: Agent) -> Agent {
        var copy = agent
        copy.events = viewedEvents(agent)
        return copy
    }

    private func reasoning(for agent: Agent) -> [AgentEvent] { reasoningEvents(viewedEvents(agent)) }

    private func shell(for agent: Agent) -> [AgentEvent] { terminalEvents(viewedEvents(agent)) }

    /// Prefer the bridge's full record of what was changed: the live snapshot
    /// drops a diff off an edit as its window rolls, so the events already in
    /// hand are a worse answer than the ones fetched for this.
    private var fileChanges: [AgentFileChange] {
        agentFileChanges(store.sessionChanges[agentId] ?? [])
    }

    private var slashMatches: [SlashCommand] {
        guard let query = slashCommandQuery(draft) else { return [] }
        return matchSlashCommands(query, store.slashCommands[agentId] ?? [])
    }

    private func wantsPerson(_ agent: Agent) -> Bool {
        agent.state == "waiting" && (agent.pendingApproval != nil || openQuestion(agent) != nil)
    }

    private func attentionBanner(_ agent: Agent) -> some View {
        Button { mode = .chat } label: {
            HStack(spacing: 8) {
                Image(systemName: agent.pendingApproval != nil ? "checkmark.shield" : "questionmark.circle")
                    .font(.system(size: 14))
                Text(agent.pendingApproval != nil ? "Approval required" : "Question waiting")
                    .font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 0)
                Text("Review in Chat")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.muted)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.muted)
            }
            .foregroundStyle(Palette.amber)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(Palette.amber.opacity(0.10)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.amber.opacity(0.22), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 3)
    }

    // MARK: - Conversation

    private func conversation(for agent: Agent) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if !loadedHistory, entries(for: agent).isEmpty {
                        ProgressView().tint(Palette.muted).frame(maxWidth: .infinity).padding(.vertical, 40)
                    } else if entries(for: agent).isEmpty {
                        EmptyConversation(agent: agent, lensed: lens != nil)
                    }
                    let conversation = entries(for: agent)
                    ForEach(Array(conversation.enumerated()), id: \.element.id) { index, entry in
                        // A hairline where an exchange opens — never before the
                        // first entry, which opens nothing.
                        if index > 0, startsNewTurn(previous: conversation[index - 1].event, current: entry.event) {
                            TurnHairline()
                        }
                        ConversationBubble(entry: entry, harness: agent.harness, model: agent.model)
                            .id(entry.id)
                    }
                    if lens != nil {
                        // Nothing to answer here: a subagent does not hold the
                        // session's approval.
                        EmptyView()
                    } else if let approval = agent.pendingApproval {
                        ApprovalCard(agent: agent, approval: approval, busy: $busy, failure: $failure)
                            .id("pending")
                    } else if let question = openQuestion(agent) {
                        QuestionCard(agent: agent, question: question, busy: $busy, failure: $failure)
                            .id("pending")
                    }
                    if let failure {
                        Text(failure)
                            .font(.system(size: 12))
                            .foregroundStyle(Palette.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 18)
            }
            // A short conversation rests on the composer rather than floating
            // at the top of an empty screen.
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: agent.events.count) { _, _ in scrollToEnd(proxy, agent: agent) }
            .onChange(of: loadedHistory) { _, _ in scrollToEnd(proxy, agent: agent) }
            .onAppear { scrollToEnd(proxy, agent: agent) }
        }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy, agent: Agent) {
        let target = agent.pendingApproval != nil || openQuestion(agent) != nil
            ? "pending"
            : entries(for: agent).last?.id
        guard let target else { return }
        DispatchQueue.main.async { proxy.scrollTo(target, anchor: .bottom) }
    }

    /// History plus whatever the live snapshot has that has not been fetched.
    private func sessionEvents(_ agent: Agent) -> [AgentEvent] {
        mergeSessionEvents(history: history, live: agent.events)
    }

    /// The session, or one subagent's slice of it.
    private func viewedEvents(_ agent: Agent) -> [AgentEvent] {
        guard let lens else { return sessionEvents(agent) }
        return eventsOfSubagent(sessionEvents(agent), subagentId: lens)
    }

    private func entries(for agent: Agent) -> [ConversationEntry] {
        conversationEntries(viewedEvents(agent))
    }

    /// The newest event is a question only while it is still the newest —
    /// once the runtime moves on, the question was answered elsewhere. The
    /// durable request is preferred so a question survives past the live window.
    private func openQuestion(_ agent: Agent) -> PendingQuestion? {
        guard agent.state == "waiting" else { return nil }
        if let question = agent.pendingQuestion { return question }
        guard let newest = agent.events.max(by: { $0.createdAt < $1.createdAt }), newest.kind == "question" else { return nil }
        let text = !newest.summary.trimmed.isEmpty && newest.summary != "Question"
            ? newest.summary
            : (newest.detail?.trimmed.nonEmpty ?? "Agent has a question")
        return PendingQuestion(id: newest.id, question: text, options: newest.options, createdAt: newest.createdAt, expiresAt: "")
    }

    /// A refetch is a top-up, not a reload: blanking the transcript back to a
    /// spinner every twenty seconds would be worse than the staleness it fixes.
    private func loadHistory() async {
        guard let fetched = try? await store.history(agentId: agentId, limit: 300) else {
            loadedHistory = true
            return
        }
        history = fetched
        loadedHistory = true
    }

    // MARK: - Composer

    @ViewBuilder private func composer(for agent: Agent) -> some View {
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
                if let notice = deliveryNotice(agent) {
                    Text(notice)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(Palette.surfaceRaised))
                        .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
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
        if lens != nil { return "Message the session…" }
        return action == "steer" ? "Reply or steer…" : "Message agent…"
    }

    /// A message to a session that is not on a turn will not be seen until it
    /// takes one. Saying so up front is the difference between a queue and a
    /// message that seems to have vanished.
    private func deliveryNotice(_ agent: Agent) -> String? {
        switch agent.state {
        case "running": nil
        case "offline": "Queued · session is offline"
        default: "Queued · delivers at the next turn"
        }
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
                // Points at the pending card, which lives in the Chat
                // transcript — the same place the attention banner sends people.
                Button {
                    blockedNotice = nil
                    mode = .chat
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
        let message = draft.trimmed
        guard !message.isEmpty else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await store.control(agentId: agentId, action: action, value: message, force: force)
            draft = ""
            blockedNotice = nil
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

/// The four faces of a session. The icons are the ones the views themselves
/// use, so the tab and the thing it opens agree about what they are.
enum SessionTab: CaseIterable {
    case chat, reasoning, changes, terminal

    var label: String {
        switch self {
        case .chat: "Chat"
        case .reasoning: "Reasoning"
        case .changes: "Changes"
        case .terminal: "Terminal"
        }
    }

    var icon: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .reasoning: "brain"
        case .changes: "plusminus"
        case .terminal: "terminal"
        }
    }
}

private struct SessionTabBar: View {
    @Binding var mode: SessionTab
    @Binding var tabChosen: Bool
    var attention: Bool
    var reasoning: Int
    var changes: Int
    var terminal: Int

    var body: some View {
        HStack(spacing: 0) {
            ForEach(SessionTab.allCases, id: \.self) { tab in
                Button {
                    mode = tab
                    tabChosen = true
                } label: {
                    VStack(spacing: 5) {
                        // An icon rather than a word: four labels sharing the
                        // width truncate to names that name nothing. The dot is
                        // what a count used to be — a busy session reads "99+"
                        // on every tab, which says only that there is a lot of
                        // everything.
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: tab.icon)
                                .font(.system(size: 19, weight: mode == tab ? .semibold : .regular))
                                .foregroundStyle(mode == tab ? Palette.text : Palette.muted)
                            if badge(for: tab) {
                                Circle()
                                    // Amber is reserved for something wanting a
                                    // person; anything else is content waiting
                                    // to be read.
                                    .fill(tab == .chat ? Palette.amber : Palette.muted.opacity(0.7))
                                    .frame(width: tab == .chat ? 7 : 5, height: tab == .chat ? 7 : 5)
                                    .offset(x: 5, y: -3)
                            }
                        }
                        .frame(height: 24)
                        Rectangle()
                            .fill(mode == tab ? Palette.signal : .clear)
                            .frame(height: 2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.label)
            }
        }
        .background(Palette.ink)
    }

    /// True when this tab has content worth marking, as a dot rather than a
    /// number.
    private func badge(for tab: SessionTab) -> Bool {
        switch tab {
        case .chat: attention
        case .reasoning: reasoning > 0
        case .changes: changes > 0
        case .terminal: terminal > 0
        }
    }
}

/// The `/` commands this runtime advertises, offered while the caret is still
/// in the command token.
struct SlashCommandPicker: View {
    var matches: [SlashCommand]
    var onPick: (SlashCommand) -> Void

    var body: some View {
        // Capped so the picker never swallows the conversation; it scrolls
        // beyond that.
        ScrollView {
            VStack(spacing: 2) {
                ForEach(matches) { command in
                    Button { onPick(command) } label: {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text("/\(command.name)")
                                    .font(.system(size: 13, design: .monospaced))
                                    .foregroundStyle(Palette.blue)
                                    .lineLimit(1)
                                if let description = command.description, !description.trimmed.isEmpty {
                                    Text(description)
                                        .font(.system(size: 11))
                                        .foregroundStyle(Palette.muted)
                                        .multilineTextAlignment(.leading)
                                        .lineLimit(2)
                                }
                            }
                            Spacer(minLength: 0)
                            if command.source != "user" {
                                Text(command.source)
                                    .font(.system(size: 9))
                                    .foregroundStyle(Palette.muted.opacity(0.7))
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: 224)
        .background(RoundedRectangle(cornerRadius: 16).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.line, lineWidth: 1))
        .padding(.bottom, 6)
    }
}

private struct EmptyConversation: View {
    var agent: Agent
    var lensed: Bool

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 26))
                .foregroundStyle(Palette.muted)
            Text(lensed ? "This subagent hasn't spoken" : "No responses yet")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.text)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }

    private var message: String {
        // "Send a message to begin" is not true of a subagent: it is not
        // addressable. A running one has said nothing yet; a finished one's
        // message arrives with its completion.
        // Android adds "Its work is under Changes and Terminal"; this app has
        // neither tab yet, and naming a screen that does not exist is worse
        // than saying less.
        if lensed { return "It reports back when it finishes." }
        if remoteMessageAction(state: agent.state, capabilities: agent.capabilities) == nil {
            return "This runtime is monitoring-only."
        }
        return "Send a message to begin."
    }
}

/// Which subagent to read, or the whole session.
///
/// A list rather than a switch, because a session can be running several at
/// once and they are told apart by what they are doing, not by their ids.
private struct SubagentPicker: View {
    var runs: [SubagentRun]
    @Binding var selected: String?
    @Environment(\.dismiss) private var dismiss
    // Chosen once per opening; nil means the attention-first default.
    @State private var filter: SubagentFilter?

    private var activeFilter: SubagentFilter { filter ?? defaultSubagentFilter(runs) }
    private var runningCount: Int { runs.filter { !$0.finished }.count }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Work this session handed to an agent of its own.")
                        .font(.system(size: 13))
                        .foregroundStyle(Palette.muted)
                        .padding(.bottom, 6)

                    SubagentRow(
                        title: "Whole session",
                        subtitle: "Everything, including this session's own work",
                        tint: Palette.signal,
                        running: false,
                        selected: selected == nil
                    ) { selected = nil; dismiss() }

                    // Counts make filtering informed before a tap; the chips
                    // only appear once both statuses exist to choose between.
                    if runningCount > 0 && runningCount < runs.count {
                        HStack(spacing: 8) {
                            SubagentFilterChip(label: "Running \(runningCount)", active: activeFilter == .running) { filter = .running }
                            SubagentFilterChip(label: "Done \(runs.count - runningCount)", active: activeFilter == .done) { filter = .done }
                            SubagentFilterChip(label: "All \(runs.count)", active: activeFilter == .all) { filter = .all }
                        }
                        .padding(.vertical, 2)
                    }

                    ForEach(filteredSubagentRuns(runs, filter: activeFilter, selectedId: selected)) { run in
                        SubagentRow(
                            title: run.title,
                            subtitle: run.activity,
                            tint: Palette.blue,
                            running: !run.finished,
                            selected: selected == run.id
                        ) { selected = run.id; dismiss() }
                    }
                }
                .padding(20)
            }
            .background(Palette.ink)
            .navigationTitle("Subagents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.ink, for: .navigationBar)
        }
        .presentationDetents([.medium, .large])
        .preferredColorScheme(.dark)
    }
}

private struct SubagentFilterChip: View {
    var label: String
    var active: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(active ? Palette.text : Palette.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Capsule().fill(active ? Palette.blue.opacity(0.15) : Palette.surfaceRaised))
                .overlay(Capsule().stroke(active ? Palette.blue.opacity(0.45) : Palette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

private struct SubagentRow: View {
    var title: String
    var subtitle: String
    var tint: Color
    var running: Bool
    var selected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Circle()
                    .fill(running ? tint : Palette.muted.opacity(0.5))
                    .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(tint)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(selected ? tint.opacity(0.13) : Palette.surfaceRaised))
            .overlay {
                if selected {
                    RoundedRectangle(cornerRadius: 16).stroke(tint.opacity(0.4), lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

/// The seam between exchanges: a short centered hairline, quiet enough to
/// structure the transcript without shouting over it.
private struct TurnHairline: View {
    var body: some View {
        Rectangle()
            .fill(Palette.line)
            .frame(height: 1)
            .containerRelativeFrame(.horizontal) { length, _ in length * 0.4 }
            .frame(maxWidth: .infinity)
    }
}

private struct ConversationBubble: View {
    var entry: ConversationEntry
    var harness: Harness
    var model: String

    var body: some View {
        if entry.role == .user {
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(entry.content)
                        .font(.system(size: 15))
                        .lineSpacing(5)
                        .foregroundStyle(Palette.text)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .background(BubbleShape(tail: .trailing).fill(Palette.signal.opacity(0.16)))
                    timestamp
                }
            }
        } else {
            HStack(alignment: .top, spacing: 9) {
                ProviderMark(model: model, harness: harness, diameter: 32)
                VStack(alignment: .leading, spacing: 3) {
                    VStack(alignment: .leading, spacing: 6) {
                        // A report headline — a background task finishing, a
                        // subagent's parting message — is machine-relayed, not
                        // the agent freely speaking; the label says which.
                        if let label = reportLabel {
                            HStack(spacing: 5) {
                                Image(systemName: "bolt.badge.clock")
                                    .font(.system(size: 10, weight: .semibold))
                                Text(label)
                                    .font(.system(size: 11, weight: .semibold))
                                    .lineLimit(1)
                            }
                            .foregroundStyle(Palette.blue)
                        }
                        Text(markdown(entry.content))
                            .font(.system(size: 15))
                            .lineSpacing(5)
                            .foregroundStyle(Palette.text.opacity(0.92))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(
                        BubbleShape(tail: .leading)
                            .fill(reportLabel == nil ? Palette.surfaceRaised : Palette.blue.opacity(0.08))
                    )
                    timestamp
                }
            }
        }
    }

    /// The headline of a relayed report, or nil for the agent freely speaking.
    private var reportLabel: String? {
        let summary = entry.event.summary
        return summary == "Response" || summary == "Message" ? nil : summary
    }

    /// Inline markdown only: bold, italic, code, and links render; block
    /// structure stays as written, and anything unparsable falls back to the
    /// literal text rather than a blank bubble.
    private func markdown(_ content: String) -> AttributedString {
        (try? AttributedString(
            markdown: content,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(content)
    }

    private var timestamp: some View {
        Text(clock(entry.event.createdAt))
            .font(.system(size: 10))
            .foregroundStyle(Palette.muted.opacity(0.78))
            .padding(.horizontal, 5)
    }

    private func clock(_ value: String) -> String {
        guard let date = Timestamps.parse(value) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

/// Square-ish on three corners, tucked on the one nearest its speaker.
private struct BubbleShape: Shape {
    enum Tail { case leading, trailing }
    var tail: Tail

    func path(in rect: CGRect) -> Path {
        Path(
            roundedRect: rect,
            cornerRadii: RectangleCornerRadii(
                topLeading: 18,
                bottomLeading: tail == .leading ? 5 : 18,
                bottomTrailing: tail == .trailing ? 5 : 18,
                topTrailing: 18
            )
        )
    }
}
