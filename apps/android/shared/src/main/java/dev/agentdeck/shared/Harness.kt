package dev.agentdeck.shared

/**
 * Which coding agent a session is running under.
 *
 * Read from the wire's `runtime` field when the bridge sends one, because that
 * is the adapter's own word for itself. The id-prefix and display-name reads
 * below are the fallback for snapshots from an older bridge, which had no such
 * field — and for Pi, whose id carries no prefix at all.
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
    Gemini("GM", "Gemini CLI", null),
    // Pi ships no mark that could be used here, so its own initial stands in.
    Pi("π", "Pi", null),
    // A bridge-hosted Claude session is still a Claude session.
    Managed("MC", "Managed Claude", R.drawable.harness_claude),
    Unknown("··", "Agent", null),
}

object Harnesses {
    fun of(agent: Agent): Harness = of(agent.id, agent.name, agent.runtime)

    fun of(agentId: String, name: String, runtime: String? = null): Harness = when {
        // A bridge-hosted session is still its runtime underneath, but it is
        // the bridge's, and the deck says so — the id decides before the word.
        agentId.startsWith("managed-") -> Harness.Managed
        runtime == "claude" -> Harness.Claude
        runtime == "codex" -> Harness.Codex
        runtime == "opencode" -> Harness.OpenCode
        runtime == "gemini" -> Harness.Gemini
        runtime == "pi" -> Harness.Pi
        agentId.startsWith("claude-") -> Harness.Claude
        agentId.startsWith("codex-") -> Harness.Codex
        agentId.startsWith("opencode-") -> Harness.OpenCode
        agentId.startsWith("gemini-") -> Harness.Gemini
        // Pi names its sessions from the runtime's own id, which carries no
        // prefix, so the display name is the only thing left to read.
        name.startsWith("Pi ") || name.startsWith("Pi·") -> Harness.Pi
        else -> Harness.Unknown
    }
}
