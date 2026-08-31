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
    /// The bridge's own sentence about why a message was refused: the session
    /// is blocked on an approval or question. Held separately from `failure`
    /// because it is answered with a choice, not a failure line — and the
    /// draft is kept for whichever way that choice goes.
    /// Which subagent is being read, or the whole session when nil. A session
    /// that farms work out to three subagents reported their tool calls mixed
    /// into its own, so "what is it doing" had no answer smaller than all of it.
    @State private var lens: String?
    @State private var lensPickerOpen = false
    /// The step opened for its depth — command, output, or diff — as a sheet
    /// over the conversation rather than somewhere else to be.
    @State private var openActivity: AgentEvent?
    @State private var changesOpen = false
    /// The cluster opened into its steps — a titled sheet over the conversation.
    @State private var openSteps: StepsSelection?
    /// The conversation map and the pick it made; the timeline consumes the
    /// pick by scrolling to it once.
    @State private var mapOpen = false
    @State private var mapTarget: String?
    /// Reading history after a map jump: the auto-scroll to the live edge
    /// stands down until the person speaks again or reopens the session.
    @State private var readingPast = false
    /// The reader's mark, frozen at open — beginViewing moves it, and the
    /// "New" divider must point at where it stood before.
    @State private var seenUpTo: String?
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
                    // The session is one conversation. Everything the agent
                    // did reads inline as work between the words; depth opens
                    // as a sheet over the same screen.
                    conversation(for: agent)
                    SessionComposer(
                        agentId: agentId,
                        agent: agent,
                        lensed: lens != nil,
                        busy: $busy,
                        failure: $failure,
                        onSpoke: { readingPast = false }
                    )
                }
                .sheet(isPresented: $lensPickerOpen) {
                    SubagentPicker(runs: runs, selected: $lens)
                }
                .sheet(item: $openSteps) { selection in
                    StepsSheet(events: selection.events)
                }
                .sheet(isPresented: $mapOpen) {
                    ConversationMapSheet(markers: conversationMarkers(viewedEvents(agent))) { id in
                        mapOpen = false
                        mapTarget = id
                    }
                }
                .sheet(item: $openActivity) { event in
                    ActivityDetailSheet(event: event)
                }
                .sheet(isPresented: $changesOpen) {
                    DiffView(files: fileChanges, loaded: store.changesLoaded(agentId: agentId))
                        .background(Palette.surface)
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
            if let agent {
                seenUpTo = max(store.seenMarks[agentId] ?? "", agent.viewedAt ?? "")
                if seenUpTo?.isEmpty == true { seenUpTo = nil }
            }
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
        await store.loadQueued(agentId: agentId)
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
            // The session's ledger, worn on the header: what all this work
            // has amounted to, one tap from the diffs themselves. The receipt
            // in the flow keeps the current pass; the running total lives here.
            if let stat = diffStat(store.sessionChanges[agentId] ?? []) {
                Button {
                    changesOpen = true
                } label: {
                    DiffStatLabel(stat: stat)
                }
                .accessibilityLabel("Session changes")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            // One button, holding what the row used to show: a header is a
            // place to read, and the actions were crowding the name that
            // matters. The menu carries them, each exactly as it was.
            if let agent {
                let markers = conversationMarkers(viewedEvents(agent))
                let archived = store.isArchived(agent)
                Menu {
                    if markers.count > 1 {
                        Button {
                            mapOpen = true
                        } label: {
                            Label("Conversation map", systemImage: "list.bullet")
                        }
                    }
                    // The ledger again, where the actions live: the header
                    // shows it, the menu opens it. Menus strip custom colour,
                    // so the numbers ride the title as plain text.
                    if let stat = diffStat(store.sessionChanges[agentId] ?? []) {
                        Button {
                            changesOpen = true
                        } label: {
                            Label("Changes  +\(stat.added) −\(stat.removed)", systemImage: "plusminus")
                        }
                    }
                    Button {
                        if archived { store.restore(agent) } else { store.archive(agent) }
                    } label: {
                        Label(
                            archived ? "Restore session" : "Archive session",
                            systemImage: archived ? "tray.and.arrow.up" : "archivebox"
                        )
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15))
                        .foregroundStyle(Palette.muted)
                }
                .accessibilityLabel("Session actions")
            }
        }
    }

    /// Prefer the bridge's full record of what was changed: the live snapshot
    /// drops a diff off an edit as its window rolls, so the events already in
    /// hand are a worse answer than the ones fetched for this.
    private var fileChanges: [AgentFileChange] {
        agentFileChanges(store.sessionChanges[agentId] ?? [])
    }

    /// The current pass: everything since the last instruction.
    private func passChanges(for agent: Agent) -> [AgentEvent] {
        guard let at = latestInstructionAt(viewedEvents(agent)) else { return [] }
        return (store.sessionChanges[agentId] ?? []).filter { $0.createdAt > at }
    }

    private func wantsPerson(_ agent: Agent) -> Bool {
        agent.state == "waiting" && (agent.pendingApproval != nil || openQuestion(agent) != nil)
    }

    // MARK: - Conversation

    private func conversation(for agent: Agent) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Folded once per render: this used to run three times, and
                // it is the most expensive thing this screen does.
                let timeline = chatTimeline(viewedEvents(agent))
                LazyVStack(alignment: .leading, spacing: 12) {
                    if !loadedHistory, timeline.isEmpty {
                        ProgressView().tint(Palette.muted).frame(maxWidth: .infinity).padding(.vertical, 40)
                    } else if timeline.isEmpty {
                        EmptyConversation(agent: agent, lensed: lens != nil)
                    }
                    let newIndex = firstUnseenIndex(timeline, seenUpTo: seenUpTo)
                    ForEach(Array(timeline.enumerated()), id: \.element.id) { index, item in
                        // Where the news begins for a returning reader.
                        if index == newIndex {
                            NewDivider()
                        }
                        // A hairline where an exchange opens — never before the
                        // first entry, which opens nothing. The New divider is
                        // already a boundary; two lines would say it twice.
                        if index > 0, index != newIndex, startsNewTurn(previous: timeline[index - 1].newestEvent, current: item.leadEvent) {
                            TurnHairline()
                        }
                        switch item {
                        case .message(let entry):
                            ConversationBubble(entry: entry, harness: agent.harness, model: agent.model)
                                .id(item.id)
                        case .activity(let events):
                            ActivityClusterView(
                                events: events,
                                // The last run of a working session is the one
                                // being written; it arrives open at its tail so
                                // the work is watchable.
                                live: agent.state == "running" && index == timeline.count - 1,
                                onOpenSteps: { openSteps = StepsSelection(events: $0) },
                                onOpen: { openActivity = $0 }
                            )
                            .id(item.id)
                        }
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
                    if !fileChanges.isEmpty {
                        // The session's receipt: what all that work touched,
                        // one quiet line where a conversation would leave one.
                        // Mid-conversation the question is "what did it just
                        // do", so the current pass leads and the session's
                        // running total sits under it.
                        let passChanges = passChanges(for: agent)
                        let passFiles = agentFileChanges(passChanges).count
                        let passLeads = passFiles > 0 && passFiles != fileChanges.count
                        Button { changesOpen = true } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 7) {
                                    Image(systemName: "plusminus")
                                        .font(.system(size: 12))
                                    Text(
                                        passLeads
                                            ? "\(passFiles == 1 ? "1 file" : "\(passFiles) files") changed this pass"
                                            : fileChanges.count == 1 ? "1 file changed" : "\(fileChanges.count) files changed"
                                    )
                                    .font(.system(size: 12))
                                    if let stat = diffStat(passLeads ? passChanges : store.sessionChanges[agentId] ?? []) {
                                        DiffStatLabel(stat: stat)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 11))
                                        .foregroundStyle(Palette.muted.opacity(0.7))
                                }
                            }
                            .foregroundStyle(Palette.muted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                    }
                    if agent.state == "running" {
                        // The typing indicator claims live work; over minutes
                        // of silence it shows the silence instead.
                        WorkingIndicatorView(
                            task: signalSilenceMinutes(agent).map { "No signal for \($0)m" } ?? agent.task
                        )
                            .id("working")
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
            .onAppear {
                readingPast = false
                scrollToEnd(proxy, agent: agent)
            }
            // A picked marker is a decision to read history: jump there and
            // stop following the live edge until the person speaks again.
            .onChange(of: mapTarget) { _, target in
                guard let target else { return }
                readingPast = true
                DispatchQueue.main.async {
                    withAnimation(.easeOut(duration: 0.25)) {
                        proxy.scrollTo("item:\(target)", anchor: .top)
                    }
                }
                mapTarget = nil
            }
        }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy, agent: Agent) {
        if readingPast { return }
        let target: String? = if agent.pendingApproval != nil || openQuestion(agent) != nil {
            "pending"
        } else if agent.state == "running" {
            "working"
        } else {
            chatTimeline(viewedEvents(agent)).last?.id
        }
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

}


/// The four faces of a session. The icons are the ones the views themselves
/// use, so the tab and the thing it opens agree about what they are.
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

/// Where the news begins for a returning reader — the messaging idiom.
private struct NewDivider: View {
    var body: some View {
        HStack(spacing: 9) {
            Rectangle().fill(Palette.signal.opacity(0.35)).frame(height: 1)
            Text("New")
                .font(.system(size: 10, weight: .semibold))
                .kerning(0.8)
                .foregroundStyle(Palette.signal)
            Rectangle().fill(Palette.signal.opacity(0.35)).frame(height: 1)
        }
        .padding(.vertical, 4)
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

/// A cluster's steps, wrapped so a sheet can present them by identity.
private struct StepsSelection: Identifiable {
    var events: [AgentEvent]
    var id: String { events.first?.id ?? "steps" }
}
