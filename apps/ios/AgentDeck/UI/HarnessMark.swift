import SwiftUI

/// The runtime's own artwork on a sunken disc, with a status dot — or a
/// running ring, which replaces the dot rather than joining it.
///
/// The disc is deliberately neutral rather than harness-tinted: a white mark on
/// its own pale halo is invisible.
struct HarnessMark: View {
    var harness: Harness
    var status: Color
    var running: Bool
    var diameter: CGFloat = 50

    private var inner: CGFloat { diameter * 0.82 }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ZStack {
                Circle().fill(Palette.surfaceSunken)
                logo
                if running { RunningRing(color: status) }
            }
            .frame(width: inner, height: inner)

            if !running {
                Circle()
                    .fill(status)
                    .frame(width: 7, height: 7)
                    .padding(2)
                    .background(Circle().fill(Palette.ink))
                    .offset(x: 1.5, y: 1.5)
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityLabel(harness.label)
    }

    @ViewBuilder private var logo: some View {
        if let art = harness.artwork {
            HarnessArtwork(strokes: art.strokes, viewBox: art.viewBox)
                .frame(width: diameter * 0.5, height: diameter * 0.5)
        } else {
            // No vendor artwork exists for this runtime, so its monogram
            // stands in — never a blank disc.
            Text(harness.mark)
                .font(.system(size: diameter * 0.32, weight: .semibold))
                .foregroundStyle(harness.tint)
        }
    }
}

/// The ring a running session wears in place of its status dot.
///
/// Turned by the clock rather than by a `repeatForever` animation started in
/// `onAppear`. That animation is suspended outright in Low Power Mode, and it
/// is never restarted when the card is recycled by the lazy stack it lives in
/// or when the app comes back from the background — so on a real phone the
/// ring stood still while the simulator, which is never in Low Power Mode and
/// rarely scrolls far enough to recycle a card, span happily. Reading the
/// angle off the current time cannot be suspended or lost: every frame simply
/// asks what time it is.
private struct RunningRing: View {
    var color: Color

    /// One turn of the ring.
    private let turn: Double = 1.1

    var body: some View {
        TimelineView(.animation) { context in
            let phase = context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: turn) / turn
            ZStack {
                Circle().stroke(Palette.line, lineWidth: 2.5)
                Circle()
                    .trim(from: 0, to: 0.28)
                    .stroke(color.opacity(0.78), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(phase * 360))
            }
        }
    }
}

/// The model's provider, as a small circular mark next to the model name.
struct ProviderMark: View {
    var model: String
    var harness: Harness
    var diameter: CGFloat = 20

    var body: some View {
        ZStack {
            Circle().fill(provider.color.opacity(0.13))
            if provider.isOpenAI {
                OpenAIGlyph()
                    .stroke(provider.color, lineWidth: diameter * 0.6 * 0.16)
                    .frame(width: diameter * 0.6, height: diameter * 0.6)
            } else {
                Text(provider.initial)
                    .font(.system(size: diameter * 0.45, weight: .bold))
                    .foregroundStyle(provider.color)
                    .offset(y: -0.5)
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }

    private var provider: Provider { Provider.of(model: model, harness: harness) }
}

private struct OpenAIGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let side = min(rect.width, rect.height)
        let center = CGPoint(x: rect.midX, y: rect.midY)
        path.addArc(center: center, radius: side * 0.38, startAngle: .zero, endAngle: .degrees(360), clockwise: false)
        path.addArc(center: center, radius: side * 0.1, startAngle: .zero, endAngle: .degrees(360), clockwise: false)
        return path
    }
}

struct Provider {
    var name: String
    var color: Color
    var isOpenAI: Bool = false

    var initial: String { name.first.map(String.init) ?? "?" }

    static func of(model: String, harness: Harness) -> Provider {
        let value = model.lowercased()
        if value.contains("claude") { return Provider(name: "Anthropic", color: Palette.anthropic) }
        if value.contains("gemini") { return Provider(name: "Google", color: Color(hex: 0x78A7FF)) }
        if value.contains("grok") { return Provider(name: "xAI", color: Palette.text) }
        if value.contains("gpt") || value.contains("openai") || harness == .codex {
            return Provider(name: "OpenAI", color: Palette.signal, isOpenAI: true)
        }
        return Provider(name: "Provider", color: Palette.muted)
    }
}

/// `claude-sonnet-4-5` reads as "Claude Sonnet 4.5". Adjacent digit groups are
/// a version, not two words.
func humanizeModelId(_ value: String) -> String {
    let parts = value.split(separator: "-").map(String.init).filter { !$0.isEmpty }
    var result: [String] = []
    var index = 0
    while index < parts.count {
        let current = parts[index]
        let next = index + 1 < parts.count ? parts[index + 1] : nil
        if current.allSatisfy(\.isNumber), let next, next.allSatisfy(\.isNumber) {
            result.append("\(current).\(next)")
            index += 2
        } else {
            result.append(current.prefix(1).uppercased() + current.dropFirst())
            index += 1
        }
    }
    return result.joined(separator: " ")
}
