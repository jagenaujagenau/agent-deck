import SwiftUI

/// One session as a chat: who, the last thing said, and when.
///
/// The deck used to be a dashboard of cards under section headings; a person
/// scanning for "does anything need me" had to read furniture before rows.
/// A chat list answers the same question the way every messaging app has
/// trained a thumb to read it — avatar, name, preview, time, badge — and the
/// session states become the colours of the preview line: amber when the
/// session is asking, signal while it types, quiet when it is done and read.
struct ChatRow: View {
    var agent: Agent
    var state: HomeAgentState

    /// Unread, in this deck's terms: the session wants a person, or finished
    /// and nobody has looked. Both earn the bold title and the badge.
    private var unread: Bool { state.attention || state == .done }

    private var previewColor: Color {
        switch state {
        case .failed: Palette.danger
        case _ where state.attention: Palette.amber
        // Running, but mute for minutes: amber, not the confident green.
        case .running where signalSilenceMinutes(agent) != nil: Palette.amber
        case .running: Palette.signal
        case .done: Palette.text.opacity(0.87)
        default: Palette.muted
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            HarnessMark(harness: agent.harness, status: state.color, running: agent.state == "running", diameter: 52)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 0) {
                    Text(chatTitle(agent))
                        .font(.system(size: 15, weight: unread ? .bold : .semibold))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    // The read receipt: finished work someone has already seen.
                    // SF Symbols has no double check, so this draws the pair.
                    if agent.state == "idle", !unread {
                        ZStack {
                            Image(systemName: "checkmark").offset(x: -3)
                            Image(systemName: "checkmark").offset(x: 3)
                        }
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Palette.blue.opacity(0.75))
                        .padding(.trailing, 7)
                    }
                    Text(Timestamps.freshness(SeenPolicy.activityAt(agent)))
                        .font(.system(size: 11))
                        .foregroundStyle(unread ? state.color : Palette.muted)
                }
                HStack(spacing: 8) {
                    Text(chatPreview(agent, state: state))
                        .font(.system(size: 13))
                        .foregroundStyle(previewColor)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if unread {
                        Circle().fill(state.color).frame(width: 9, height: 9)
                    }
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        // Opaque on purpose: the swipe reveal underneath must only show while
        // a swipe is actually uncovering it.
        .background(Palette.ink)
    }
}
