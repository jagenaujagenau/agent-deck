import SwiftUI

/// The furniture a terminal has: a blinking block caret, a powerline status
/// line, and text that types itself in.
/// Mirrored from `apps/android/mobile/.../TerminalChrome.kt`.

/// A block caret that blinks the way a terminal's does.
///
/// Square, not a fade: a cursor is on or it is off, and easing it makes the
/// terminal look like a web page pretending to be one. Driven by a timeline
/// rather than a repeating animation so it keeps its phase across the
/// re-renders that typing causes — an animation restarted every frame never
/// blinks at all.
struct BlinkingCaret: View {
    var color: Color
    var width: CGFloat = 9
    var height: CGFloat = 17

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.53)) { context in
            Rectangle()
                .fill(color)
                .frame(width: width, height: height)
                .opacity(Int(context.date.timeIntervalSinceReferenceDate / 0.53) % 2 == 0 ? 1 : 0)
        }
    }
}

/// The angled edge a powerline segment ends in.
///
/// A shape, because the glyph that normally draws it (U+E0B0) exists only in
/// patched fonts, and a device without one renders a hollow box across the
/// whole bar.
struct PowerlineShape: Shape {
    var arrow: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - arrow, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX - arrow, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

struct PowerlineCell: Identifiable {
    var text: String
    var background: Color
    var foreground: Color
    var action: (() -> Void)?

    var id: String { text }
}

/// The status line under the scrollback.
///
/// Segments overlap by the width of their chevron and are stacked so each one's
/// point sits over the segment after it, which is what makes the row read as a
/// single ribbon rather than a row of arrows.
struct PowerlineBar: View {
    var segments: [PowerlineCell]
    var arrow: CGFloat = 9

    var body: some View {
        HStack(spacing: -arrow) {
            ForEach(Array(segments.enumerated()), id: \.element.id) { index, cell in
                segment(cell)
                    .zIndex(Double(segments.count - index))
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder private func segment(_ cell: PowerlineCell) -> some View {
        let label = Text(cell.text)
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .kerning(0.4)
            .foregroundStyle(cell.foreground)
            .lineLimit(1)
            // Room on the right for the chevron, so the text does not run into it.
            .padding(.leading, 10)
            .padding(.trailing, arrow + 8)
            .frame(height: 24)
            .background(PowerlineShape(arrow: arrow).fill(cell.background))

        if let action = cell.action {
            Button(action: action) { label }
                .buttonStyle(.plain)
        } else {
            label
        }
    }
}

/// A command as far as it has been typed, with a caret riding the end of it.
///
/// Only what arrived after the tab opened is animated. Replaying a session's
/// whole scrollback every time the list recomposed would be unreadable, and
/// would re-type the same line each time it scrolled back into view.
struct TypedCommand: View {
    var command: String
    var animate: Bool
    var speed: TerminalTypeSpeed

    @State private var progress: Double = 1

    var body: some View {
        TypedCommandBody(command: command, progress: typing ? progress : 1)
            .onAppear(perform: restart)
            // A speed change re-runs the current line at the new rate, which is
            // how the control shows what it did.
            .onChange(of: speed) { _, _ in restart() }
            .onChange(of: command) { _, _ in restart() }
    }

    private var typing: Bool { animate && speed.charsPerSecond > 0 }

    private func restart() {
        guard typing else {
            progress = 1
            return
        }
        progress = 0
        withAnimation(.linear(duration: typingDuration(length: command.count, charsPerSecond: speed.charsPerSecond))) {
            progress = 1
        }
    }
}

/// The animated half: SwiftUI drives `progress` at display rate, and the caret
/// leaves the moment the line is whole — which is how a terminal shows the
/// difference between working and finished.
private struct TypedCommandBody: View, Animatable {
    var command: String
    var progress: Double

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    var body: some View {
        let shown = String(command.prefix(Int((Double(command.count) * progress).rounded())))
        HStack(alignment: .top, spacing: 0) {
            Text(shown)
                .font(.system(size: 14, design: .monospaced))
                .lineSpacing(4)
                .foregroundStyle(Palette.text.opacity(0.92))
                .frame(maxWidth: .infinity, alignment: .leading)
            if shown.count < command.count {
                BlinkingCaret(color: Palette.signal, width: 8, height: 16)
            }
        }
    }
}

/// Close, minimise, zoom — drawn, not wired. They are what makes a rectangle
/// read as a window at a glance.
struct WindowSemaphore: View {
    var body: some View {
        HStack(spacing: 6) {
            ForEach([0xFF5F57, 0xFEBC2E, 0x28C840], id: \.self) { hex in
                Circle()
                    .fill(Color(hex: UInt32(hex)))
                    .frame(width: 9, height: 9)
            }
        }
    }
}

/// A write to a file, drawn as the act rather than its payload.
///
/// Set apart from the shell around it because it is not a command anyone reads:
/// the interesting half is which file, and the rest is the file's own contents.
struct FileWriteLine: View {
    var verb: String
    var line: TerminalLine

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 13))
                .foregroundStyle(Palette.blue)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(verb)
                        .font(.system(size: 12, weight: .bold, design: .monospaced))
                        .foregroundStyle(Palette.blue)
                    Text(line.fileName)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                }
                if !line.fileParent.isEmpty {
                    Text(line.fileParent)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.blue.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.blue.opacity(0.3), lineWidth: 1))
    }
}
