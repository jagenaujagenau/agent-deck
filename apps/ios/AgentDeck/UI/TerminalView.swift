import SwiftUI

/// The shell on the other end of this session.
///
/// A window, because that is what it is — drawn with the chrome a person
/// already reads as one, closed on all four sides with air beneath it. A panel
/// that runs off the bottom of the screen is not a window, and the prompt needs
/// to read as sitting inside it.
struct TerminalView: View {
    @Environment(DeckStore.self) private var store
    var agent: Agent
    var events: [AgentEvent]
    @Binding var busy: Bool
    @Binding var failure: String?
    var autoFocus: Bool

    @AppStorage("terminal.speed") private var speedRaw = TerminalTypeSpeed.normal.rawValue
    @State private var command = ""
    /// Whether the view is still riding the tail. A drag says "I am reading
    /// this"; the jump button says "take me back". Nothing else moves it, so a
    /// command landing while you read scrollback does not yank you away.
    @State private var followingTail = true
    @State private var newCommandsWaiting = false
    /// Everything already on screen when this tab opened is scrollback and is
    /// drawn whole. Only what arrives afterwards is typed, so re-entering a
    /// session does not replay an hour of shell — and keying on identity rather
    /// than on rendering means a line is not re-typed each time it scrolls back
    /// into view.
    @State private var scrollback: Set<String> = []
    @State private var opened = false
    @FocusState private var promptFocused: Bool

    private var speed: TerminalTypeSpeed { TerminalTypeSpeed(rawValue: speedRaw) ?? .normal }

    var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                titleBar(proxy)
                scrollbackView(proxy)
                statusLine
                prompt
            }
            // Keyed on the newest event, not the count: history is fetched with
            // a cap, so on a long-running session the count sits pinned at that
            // cap while the contents roll underneath it — and a view watching
            // the count would never learn anything arrived again.
            .onChange(of: events.last?.id) { _, _ in
                if followingTail {
                    scrollToEnd(proxy)
                    newCommandsWaiting = false
                } else {
                    newCommandsWaiting = true
                }
            }
        }
        .background(Color(hex: 0x050709))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.line, lineWidth: 1))
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .onAppear {
            guard !opened else { return }
            opened = true
            scrollback = Set(events.map(\.id))
            if autoFocus { promptFocused = true }
        }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        guard let last = visible.last?.id else { return }
        DispatchQueue.main.async { proxy.scrollTo(last, anchor: .bottom) }
    }

    /// The tail of the scrollback.
    ///
    /// A phone does not scroll through nine hundred shell lines, and a lazy
    /// stack asked to hold them all makes every jump to the bottom an estimate
    /// across hundreds of unrealised rows — which is how the view ends up
    /// parked in blank space below its own content. The history fetch is
    /// already capped; this is the render's own cap.
    private var visible: [AgentEvent] { Array(events.suffix(120)) }

    private func titleBar(_ proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 0) {
            WindowSemaphore()
                .padding(.leading, 12)
            Text(agent.project)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Palette.text.opacity(0.7))
                .lineLimit(1)
                .padding(.leading, 12)
            Spacer(minLength: 8)
            Text("\(events.count)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Palette.muted.opacity(0.72))
            Button {
                followingTail = true
                newCommandsWaiting = false
                scrollToEnd(proxy)
            } label: {
                Image(systemName: "arrow.down.to.line")
                    .font(.system(size: 15))
                    // The follow-the-tail state lives on the button that
                    // changes it, rather than on a badge somewhere else.
                    .foregroundStyle(followingTail ? Palette.signal : Palette.muted)
                    .frame(width: 44, height: 40)
            }
            .disabled(events.isEmpty)
            .accessibilityLabel("Jump to latest command")
        }
        .frame(height: 40)
        .background(Color(hex: 0x0C1014))
    }

    private func scrollbackView(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if events.isEmpty {
                    HStack(spacing: 10) {
                        Text("$")
                            .font(.system(size: 13, weight: .bold, design: .monospaced))
                            .foregroundStyle(Palette.signal)
                        Text("Waiting for the first shell command…")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Palette.muted)
                    }
                }
                ForEach(visible) { event in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(terminalClock(event.createdAt))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Palette.muted.opacity(0.66))
                        HStack(alignment: .top, spacing: 10) {
                            Text("$")
                                .font(.system(size: 14, weight: .bold, design: .monospaced))
                                .foregroundStyle(Palette.signal)
                            switch terminalLine(event.command ?? "") {
                            case .fileWrite(let verb, _):
                                FileWriteLine(verb: verb, line: terminalLine(event.command ?? ""))
                            case .shell(let text):
                                // Only the newest command types; a burst
                                // arriving together should not put three
                                // carets on screen at once.
                                TypedCommand(
                                    command: text,
                                    animate: !scrollback.contains(event.id) && event.id == events.last?.id,
                                    speed: speed
                                )
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(event.id)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
        }
        .defaultScrollAnchor(.bottom)
        // A drag is the only thing that takes the view off the tail. Reading
        // scrollback and being dragged back to the newest line by a command you
        // did not ask about is the surface arguing with you.
        .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in followingTail = false })
        .scrollDismissesKeyboard(.interactively)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .bottom) {
            if newCommandsWaiting {
                Button {
                    followingTail = true
                    newCommandsWaiting = false
                    scrollToEnd(proxy)
                } label: {
                    Label("New commands", systemImage: "arrow.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 40)
                        .background(Capsule().fill(Palette.signal))
                }
                .buttonStyle(.plain)
                .padding(.bottom, 10)
                .transition(.opacity)
            }
        }
    }

    /// The status line a terminal actually has, in the place it has it: under
    /// the scrollback, above the prompt. The speed segment is the control for
    /// the typing above — a terminal puts its settings in its status line
    /// rather than behind a menu.
    private var statusLine: some View {
        PowerlineBar(segments: [
            PowerlineCell(text: String(agent.project.prefix(18)), background: Palette.signal, foreground: Palette.ink),
            PowerlineCell(text: agent.state.uppercased(), background: Palette.surfaceRaised, foreground: sessionStateColor(agent.state)),
            PowerlineCell(text: "\(events.count) CMD", background: Palette.surface, foreground: Palette.muted),
            PowerlineCell(
                text: "TYPE \(speed.label)",
                background: Palette.surface,
                // Off is off, not a colour saying something is running.
                foreground: speed == .off ? Palette.muted : Palette.blue
            ) {
                speedRaw = speed.next.rawValue
            },
        ])
        .padding(.leading, 8)
        .padding(.vertical, 2)
    }

    /// Not a pill. A terminal's prompt is a line at the bottom of the window,
    /// flush with the scrollback above it — a floating rounded field inside a
    /// terminal window is a chat box wearing a monospace font.
    @ViewBuilder private var prompt: some View {
        if let action = remoteMessageAction(state: agent.state, capabilities: agent.capabilities) {
            VStack(spacing: 0) {
                if let failure {
                    Text(failure)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 6)
                }
                HStack(spacing: 10) {
                    Text("$")
                        .font(.system(size: 15, weight: .bold, design: .monospaced))
                        .foregroundStyle(Palette.signal)
                    TextField("", text: $command, axis: .vertical)
                        .font(.system(size: 14, design: .monospaced))
                        .lineLimit(1 ... 4)
                        .foregroundStyle(Palette.text)
                        .tint(Palette.signal)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .focused($promptFocused)
                    // The caret only stands in while the field is not focused.
                    // Once it is, the text field draws a real one, and two
                    // cursors on a prompt is worse than none.
                    if !promptFocused, command.isEmpty {
                        BlinkingCaret(color: Palette.signal)
                    }
                    Button {
                        Task { await send(action: action) }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Palette.ink)
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(Palette.signal))
                    }
                    .disabled(command.trimmed.isEmpty || busy)
                    .opacity(command.trimmed.isEmpty || busy ? 0.4 : 1)
                    .accessibilityLabel("Run command")
                }
                .padding(.leading, 14)
                .padding(.trailing, 6)
                .padding(.vertical, 6)
            }
            .background(Color(hex: 0x080B0E))
        } else {
            Text("This runtime does not accept remote messages.")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Color(hex: 0x080B0E))
        }
    }

    private func send(action: String) async {
        let typed = command.trimmed
        guard !typed.isEmpty else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            // A runtime has no shell of its own to hand this to — it has a
            // shell tool, and reaching it means asking in words.
            try await store.control(agentId: agent.id, action: action, value: terminalCommandInstruction(typed))
            command = ""
        } catch {
            failure = BridgeError.from(error).localizedDescription
        }
    }
}

/// A terminal timestamps to the second; a chat does not.
func terminalClock(_ value: String) -> String {
    guard let date = Timestamps.parse(value) else { return String(value.suffix(8)) }
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter.string(from: date)
}
