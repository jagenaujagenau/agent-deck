import SwiftUI

/// One committed dark world. There is no light mode and no dynamic color: the
/// deck is glanced at, and a surface whose meaning depends on the ambient theme
/// is a surface you have to read twice.
enum Palette {
    static let ink = Color(hex: 0x090C10)
    static let surface = Color(hex: 0x11161C)
    static let surfaceRaised = Color(hex: 0x181E25)
    /// Darker than whatever it sits in, so the harness disc reads as a well.
    static let surfaceSunken = Color(hex: 0x0E1319)
    static let line = Color(hex: 0x252D36)
    static let text = Color(hex: 0xF2F5F7)
    static let muted = Color(hex: 0x8D99A6)
    static let signal = Color(hex: 0x83E6B2)
    /// Reserved for "something wants a person". Never decoration.
    static let amber = Color(hex: 0xFFC266)
    static let danger = Color(hex: 0xFF7B7B)
    static let blue = Color(hex: 0x8CB7FF)

    /// The one vendor color that is not ours to choose.
    static let anthropic = Color(hex: 0xD97757)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

extension HomeAgentState {
    var color: Color {
        switch self {
        case .approvalRequired, .question, .inputRequired: Palette.amber
        case .failed: Palette.danger
        case .running: Palette.signal
        // Blue, not amber: an unseen finish is content waiting to be read, not
        // a session asking for a person.
        case .done, .recentlyCompleted: Palette.blue
        case .paused, .history: Palette.muted
        }
    }
}

extension Harness {
    /// The vendor's own color where the mark has one; the palette's otherwise.
    var tint: Color {
        switch self {
        case .claude, .managed: Palette.anthropic
        case .codex: Palette.text
        case .opencode: Palette.signal
        case .gemini: Palette.blue
        case .pi: Palette.blue
        case .unknown: Palette.muted
        }
    }
}

/// The session header uses the raw runtime state rather than the deck's
/// presentation grouping — inside a session, "paused" is a state you put it in,
/// not a shelf it was filed on.
func sessionStateColor(_ state: String) -> Color {
    switch state {
    case "running": Palette.signal
    case "waiting": Palette.amber
    case "paused": Palette.blue
    case "error", "offline": Palette.danger
    default: Palette.muted
    }
}

extension Harness {
    /// The vendor's own drawing, where one exists.
    var artwork: (viewBox: CGSize, strokes: [HarnessStroke])? {
        switch self {
        case .claude, .managed: HarnessArt.claude
        case .codex: HarnessArt.codex
        case .opencode: HarnessArt.openCode
        case .gemini, .pi, .unknown: nil
        }
    }
}
