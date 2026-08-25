package dev.agentdeck.shared

/**
 * Which coding agent a session is running under.
 *
 * Derived rather than reported: the wire has no runtime field on an agent, and
 * adding one would mean a bridge change every adapter has to catch up with. The
 * id prefix is what the adapters already agree on, and every one of them builds
 * it the same way - runtime, then a hash of the runtime's own session id.
 */
enum class Harness(val mark: String, val label: String, val icon: Int?) {
    /**
     * The runtime's own mark where there is one, and a monogram where there is
     * not. `icon` is null rather than a stand-in drawable so a surface can tell
     * the difference and fall back to [mark] instead of drawing a blank.
     */
    Claude("CC", "Claude Code", R.drawable.harness_claude),
    Codex("CX", "Codex", R.drawable.harness_codex),
    OpenCode("OC", "OpenCode", R.drawable.harness_opencode),
    // Pi ships no mark that could be used here, so its own initial stands in.
    Pi("π", "Pi", null),
    // A bridge-hosted Claude session is still a Claude session.
    Managed("MC", "Managed Claude", R.drawable.harness_claude),
    Unknown("··", "Agent", null),
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
