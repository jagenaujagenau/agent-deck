package dev.agentdeck.wear

/**
 * What a session is called, on a screen with no room for its full name.
 *
 * Names arrive as "Claude · fx-ruby · 27d9". The project is already the heading
 * directly above, and the short id identifies a session to the bridge rather
 * than to a person - neither earns space on a wrist. What is left is the thing
 * a person actually reads: which runtime this is.
 */
internal fun agentLabel(name: String, project: String): String {
    val parts = name.split(" · ").map { it.trim() }.filter { it.isNotEmpty() }
    val kept = parts.filterNot { part ->
        part.equals(project, ignoreCase = true) || isShortId(part)
    }
    // A name that is nothing but a project and an id still has to say something.
    return if (kept.isEmpty()) name else kept.joinToString(" · ")
}

/** The trailing hex stamp the bridge uses to tell two sessions apart. */
private fun isShortId(part: String) =
    part.length in 4..12 && part.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }
