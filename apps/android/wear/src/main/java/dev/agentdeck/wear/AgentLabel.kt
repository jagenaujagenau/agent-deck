package dev.agentdeck.wear

/**
 * An agent's name with the project taken out of it.
 *
 * Names arrive as "Claude · fx-ruby · 27d9", and the list already groups by
 * project with that name as the heading directly above. Repeating it costs the
 * width that distinguishes one session from another, which on a watch is the
 * difference between reading "Claude · 27d9" and reading "Claude · …".
 */
internal fun agentLabel(name: String, project: String): String {
    if (project.isBlank()) return name
    val parts = name.split(" · ").filter { it.isNotBlank() }
    val kept = parts.filterNot { it.equals(project, ignoreCase = true) }
    // A name that is only its project still has to say something.
    return if (kept.isEmpty()) name else kept.joinToString(" · ")
}
