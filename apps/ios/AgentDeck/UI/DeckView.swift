import SwiftUI

/// The deck: every session, grouped by what it wants and then by the project
/// it belongs to.
struct DeckView: View {
    @Environment(DeckStore.self) private var store
    @State private var showConnect = false
    @State private var showStart = false
    @State private var selected: String?
    /// Freshness and the ten-minute "recently completed" window both move on
    /// their own; without a tick the deck would quietly go stale.
    @State private var now = Date()

    private let tick = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    /// Agents or Usage. Two destinations, so a bar rather than a menu.
    @State private var destination: DeckDestination = .agents

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if destination == .agents {
                    wordmark
                    content
                } else {
                    UsageView()
                }
            }
            // A safe-area inset rather than a floating overlay: the scroll view
            // still runs full height so content passes under the bar, but the
            // bar is a sibling of the list rather than a layer on top of it —
            // and a layer on top of a scroll view is a layer the scroll view
            // goes on taking the taps through.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                DeckBottomBar(destination: $destination)
            }
            .background(Palette.ink)
            // The wordmark is drawn rather than set as a navigation title: the
            // system bar renders a custom title view as a glass capsule sized
            // to a button, which cropped it to "A…".
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $selected) { id in
                SessionView(agentId: id)
            }
        }
        .tint(Palette.signal)
        .sheet(isPresented: $showConnect) { ConnectView() }
        .sheet(isPresented: $showStart) {
            StartSessionView(
                projects: store.allAgents.map(\.project).filter { !$0.isEmpty }.deduplicated,
                // Most recently active first: the directory someone wants
                // another session in is almost always the one they just left.
                cwds: store.allAgents
                    .sorted { $0.lastSeenAt > $1.lastSeenAt }
                    .compactMap(\.cwd)
                    .filter { !$0.isEmpty }
                    .deduplicated
            )
        }
        .onReceive(tick) { now = $0 }
        // The notification a phone posts for an approval has to land on the
        // session it is about, so the deck answers the same link the Android
        // app does: agentdeck://agent/<id>.
        .onOpenURL { url in
            guard url.scheme == "agentdeck", url.host == "agent" else { return }
            let id = url.pathComponents.dropFirst().joined(separator: "/")
            // A notification about an archived session still opens it. Being
            // told about something and then not finding it is worse than the
            // archive briefly not holding.
            if !id.isEmpty {
                destination = .agents
                selected = id
            }
        }
        .task {
            store.start()
            ApprovalNotifier.shared.register()
        }
    }

    private var wordmark: some View {
        HStack {
            Text("Agent Deck")
                .font(.system(size: 24, weight: .bold))
                .kerning(-0.5)
                .foregroundStyle(Palette.signal)
            Spacer()
            Button { showStart = true } label: {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Palette.text)
                    .frame(width: 40, height: 40)
            }
            .accessibilityLabel("Start a session")
            Button { showConnect = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Palette.muted)
                    .frame(width: 40, height: 40)
            }
            .accessibilityLabel("Bridge settings")
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 2)
    }

    @ViewBuilder private var content: some View {
        if store.snapshot == nil {
            EmptyBridge(showConnect: $showConnect)
        } else {
            list
        }
    }

    private var list: some View {
        @Bindable var store = store
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 8, pinnedViews: []) {
                DeckHeader(now: now)
                FilterChips(filter: $store.filter, attention: store.attentionCount(now: now))
                    .padding(.bottom, 4)

                if let failure = store.failure, store.snapshot != nil {
                    StaleBanner(failure: failure)
                }

                let groups = store.groups(now: now)
                if groups.isEmpty {
                    Text("No agents in this view")
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 32)
                } else {
                    ForEach(sections(of: groups), id: \.state) { section in
                        StateHeader(state: section.state, count: section.count)
                        ForEach(section.groups) { group in
                            ProjectHeader(project: group.project, count: group.agents.count)
                            ForEach(group.agents) { agent in
                                CardSwipe(
                                    // History is already the shelf things end up
                                    // on; archiving from it has nowhere to put them.
                                    onArchive: store.filter == .history ? nil : {
                                        withAnimation(.easeOut(duration: 0.2)) { store.archive(agent) }
                                    },
                                    // Dismiss asks the bridge itself to drop the
                                    // card. Offline sessions only: the bridge
                                    // resurrects a live one on its next beat,
                                    // which would read as a broken gesture.
                                    onDismiss: agent.state == "offline" ? {
                                        withAnimation(.easeOut(duration: 0.2)) { store.dismiss(agentId: agent.id) }
                                    } : nil
                                ) {
                                    Button { selected = agent.id } label: {
                                        AgentCard(agent: agent, state: group.state)
                                    }
                                    .buttonStyle(PressableCard())
                                }
                                // Identity per session, so a row's swipe state
                                // belongs to the session and not to the slot it
                                // happened to occupy.
                                .id(agent.id)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .refreshable { await store.refresh() }
        .scrollIndicators(.hidden)
    }

    private struct Section {
        var state: HomeAgentState
        var groups: [DeckGroup]
        var count: Int
    }

    private func sections(of groups: [DeckGroup]) -> [Section] {
        var sections: [Section] = []
        for group in groups {
            if let last = sections.indices.last, sections[last].state == group.state {
                sections[last].groups.append(group)
                sections[last].count += group.agents.count
            } else {
                sections.append(Section(state: group.state, groups: [group], count: group.agents.count))
            }
        }
        return sections
    }
}

enum DeckDestination { case agents, usage }

/// A floating capsule rather than a full-width bar: content keeps running
/// underneath it, which reads as one continuous surface instead of a screen cut
/// in two.
private struct DeckBottomBar: View {
    @Binding var destination: DeckDestination

    var body: some View {
        HStack(spacing: 2) {
            item("bolt.fill", "Agents", .agents)
            item("chart.bar.fill", "Usage", .usage)
        }
        .padding(6)
        .background(Capsule().fill(Palette.surfaceRaised.opacity(0.94)))
        .overlay(Capsule().stroke(Palette.line.opacity(0.7), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
        .padding(.bottom, 8)
    }

    private func item(_ icon: String, _ label: String, _ target: DeckDestination) -> some View {
        let selected = destination == target
        return Button {
            withAnimation(.easeOut(duration: 0.18)) { destination = target }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 15))
                Text(label).font(.system(size: 13, weight: selected ? .semibold : .medium))
            }
            .foregroundStyle(selected ? Palette.signal : Palette.muted)
            // A minimum width keeps the capsule from resizing as the selection
            // moves between labels.
            .frame(minWidth: 104, minHeight: 44)
            .background(Capsule().fill(selected ? Palette.signal.opacity(0.14) : .clear))
            // The whole pill, not just its glyphs: an unselected item's
            // background is clear, and a clear background takes no taps.
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// Swipe a card left to act on it: archive at the first stop, and — on a card
/// that offers it — dismiss at a deliberately deeper one.
///
/// A gesture rather than a `List` row action: the deck is a lazy stack of cards
/// grouped under their own headers, and a `List` would bring its own separators
/// and insets to a layout that is not a list of rows. Archive is a device
/// decision — the runtime keeps running and the bridge is never told. Dismiss
/// is the destructive one: it asks the bridge itself to drop the session from
/// the deck, so it sits further out than a flick can reach by accident.
struct CardSwipe<Content: View>: View {
    var onArchive: (() -> Void)?
    var onDismiss: (() -> Void)?
    @ViewBuilder var content: Content

    @State private var offset: CGFloat = 0

    /// Far enough that it cannot be a mis-swipe on a horizontal filter row.
    private let threshold: CGFloat = 96
    /// The second stop, when both actions are on offer.
    private let farThreshold: CGFloat = 200

    var body: some View {
        content
            .offset(x: offset)
            .background(alignment: .trailing) {
                if offset < -8 {
                    HStack(spacing: 6) {
                        Image(systemName: showsDismiss ? "trash.fill" : "archivebox.fill")
                        Text(showsDismiss ? "Dismiss" : "Archive").font(.system(size: 13, weight: .semibold))
                    }
                    // Archive is muted, not amber: putting something away is
                    // not the deck asking for anything. Dismiss is danger,
                    // because the deck itself forgets the card.
                    .foregroundStyle(labelColor)
                    .padding(.trailing, 22)
                }
            }
            // High priority, or the card's own button claims the touch and a
            // swipe reads as a tap. A minimum distance means a real tap never
            // satisfies this gesture, so the button still gets those.
            .highPriorityGesture(onArchive != nil || onDismiss != nil ? drag : nil)
            // The row that swiped away comes back under History, and it must
            // come back in one piece: without this it returns still carrying
            // the offset that took it off screen, and reads as an empty slot.
            .onAppear { offset = 0 }
    }

    /// Dismiss owns the label when it is the only action, or once the drag has
    /// passed the far stop where a release would take it.
    private var showsDismiss: Bool {
        guard onDismiss != nil else { return false }
        return onArchive == nil || -offset > farThreshold
    }

    private var labelColor: Color {
        let armed = -offset > (showsDismiss && onArchive != nil ? farThreshold : threshold)
        if showsDismiss { return armed ? Palette.danger : Palette.muted }
        return armed ? Palette.text : Palette.muted
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 18)
            .onChanged { value in
                // Leftward only. A rightward drag on a card belongs to whatever
                // horizontal scroller it might be sitting in.
                offset = min(0, value.translation.width)
            }
            .onEnded { value in
                let travel = -value.translation.width
                if let onDismiss, travel > (onArchive == nil ? threshold : farThreshold) {
                    withAnimation(.easeOut(duration: 0.18)) { offset = -600 }
                    onDismiss()
                } else if let onArchive, travel > threshold {
                    withAnimation(.easeOut(duration: 0.18)) { offset = -600 }
                    onArchive()
                } else {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { offset = 0 }
                }
            }
    }
}

/// A card that gives under the finger. 0.96 is enough to feel and not enough
/// to look like it moved.
struct PressableCard: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct DeckHeader: View {
    @Environment(DeckStore.self) private var store
    var now: Date

    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(store.phase == .connected ? Palette.signal : Palette.danger)
                .frame(width: 7, height: 7)
            Text(bridgeName)
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
            Text(" · ")
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted.opacity(0.6))
            Text(status)
                .font(.system(size: 13))
                .foregroundStyle(attention > 0 ? Palette.amber : Palette.muted)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.bottom, 4)
    }

    private var attention: Int { store.attentionCount(now: now) }
    private var running: Int { store.agents.filter { $0.state == "running" }.count }

    private var bridgeName: String {
        guard let snapshot = store.snapshot else { return "Bridge offline" }
        // Over Tailscale HTTPS the bridge's own name is less useful than the
        // fact that the route is the private one.
        if store.connection.baseURL.hasPrefix("https://") { return "Secure tailnet" }
        return snapshot.bridge.name
    }

    private var status: String {
        let needs = attention == 1 ? "1 needs you" : "\(attention) need you"
        switch (attention, running) {
        case (0, 0): return "No active work"
        case (0, _): return "\(running) running"
        case (_, 0): return needs
        default: return "\(needs) · \(running) running"
        }
    }
}

private struct FilterChips: View {
    @Binding var filter: HomeFilter
    var attention: Int

    var body: some View {
        HStack(spacing: 8) {
            ForEach(HomeFilter.allCases) { option in
                let selected = filter == option
                Button {
                    withAnimation(.easeOut(duration: 0.18)) { filter = option }
                } label: {
                    HStack(spacing: 6) {
                        if option == .attention, attention > 0 {
                            Text("\(attention)")
                                .font(.system(size: 13, weight: .bold))
                        }
                        Text(option.label)
                            .font(.system(size: 13, weight: selected ? .semibold : .regular))
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 34)
                    .foregroundStyle(selected ? Palette.signal : Palette.muted)
                    .background(Capsule().fill(selected ? Palette.signal.opacity(0.16) : Palette.surface))
                    .overlay(Capsule().stroke(Palette.line.opacity(selected ? 0 : 1), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct StateHeader: View {
    var state: HomeAgentState
    var count: Int

    var body: some View {
        HStack {
            Text(state.sectionLabel)
                .font(.system(size: 10, weight: .bold))
                .kerning(1.1)
                .foregroundStyle(state.color)
            Spacer()
            Text("\(count)")
                .font(.system(size: 11))
                .foregroundStyle(Palette.muted)
        }
        .padding(.top, 10)
        .padding(.bottom, 1)
    }
}

private struct ProjectHeader: View {
    var project: String
    var count: Int

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "folder")
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
            Text(project)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(count == 1 ? "1 session" : "\(count) sessions")
                .font(.system(size: 11))
                .foregroundStyle(Palette.muted)
        }
        .padding(.top, 7)
        .padding(.bottom, 1)
    }
}

/// Shown over a snapshot we still have. A blank screen is a worse answer than
/// a stale one that says so.
private struct StaleBanner: View {
    var failure: BridgeError

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: failure == .unauthorized ? "lock.slash" : "cloud.slash")
                .font(.system(size: 15))
            Text("Showing last update · \(failure.localizedDescription)")
                .font(.system(size: 12))
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .foregroundStyle(failure == .unauthorized ? Palette.amber : Palette.danger)
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 16).fill((failure == .unauthorized ? Palette.amber : Palette.danger).opacity(0.10)))
    }
}

/// The no-snapshot state. A refused credential and an absent bridge get
/// different words and different buttons, because conflating them sends people
/// to the wrong fix.
private struct EmptyBridge: View {
    @Environment(DeckStore.self) private var store
    @Binding var showConnect: Bool

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 32))
                .foregroundStyle(Palette.muted)
                .padding(22)
                .background(Circle().fill(Palette.surfaceRaised))

            Text(title)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Palette.text)
            Text(message)
                .font(.system(size: 14))
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                Button(unauthorized ? "Pair device" : "Change bridge") { showConnect = true }
                    .buttonStyle(.bordered)
                    .tint(Palette.muted)
                Button("Try again") { Task { await store.refresh(); store.start() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.signal)
                    .foregroundStyle(Palette.ink)
            }
            .padding(.top, 4)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var unauthorized: Bool { store.failure == .unauthorized }

    private var title: String {
        if !store.connection.isConfigured { return "No bridge yet" }
        if let failure = store.failure { return failure.title }
        return "Finding your agents…"
    }

    private var message: String {
        if !store.connection.isConfigured {
            return "Point this phone at the bridge running on your Mac."
        }
        if unauthorized {
            return "The bridge refused this device's token. Enter a fresh pairing code to reconnect."
        }
        if let failure = store.failure { return failure.localizedDescription }
        return "Connecting securely over your tailnet"
    }
}
