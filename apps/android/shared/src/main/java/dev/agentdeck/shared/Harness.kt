package dev.agentdeck.shared

/**
 * Which coding agent a session is running under.
 *
 * Derived rather than reported: the wire has no runtime field on an agent, and
 * adding one would mean a bridge change every adapter has to catch up with. The
 * id prefix is what the adapters already agree on, and every one of them builds
 * it the same way - runtime, then a hash of the runtime's own session id.
 */
enum class Harness(val mark: String, val label: String) {
    /**
     * Two-letter monograms rather than brand marks. Shipping other companies'
     * logos is not something to do casually, and an invented mark would be
     * worse than an honest abbreviation. Drop-in drawables can replace these
     * without touching anything that reads them.
     */
    Claude("CC", "Claude Code"),
    Codex("CX", "Codex"),
    OpenCode("OC", "OpenCode"),
    Pi("π", "Pi"),
    Managed("MC", "Managed Claude"),
    Unknown("··", "Agent"),
}

object Harnesses {
    fun of(agentId: String, name: String): Harness = when {
        agentId.startsWith("claude-") -> Harness.Claude
        agentId.startsWith("codex-") -> Harness.Codex
        agentId.startsWith("opencode-") -> Harness.OpenCode
        agentId.startsWith("managed-") -> Harness.Managed
        // Pi names its sessions from the runtime's own id, which carries no
        // prefix, so the display name is the only thing left to read.
        name.startsWith("Pi ") || name.startsWith("Pi·") -> Harness.Pi
        else -> Harness.Unknown
    }
}
