package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import java.time.Instant

/**
 * The working directories the bridge has already run sessions in, most
 * recently active first. A managed session's `cwd` must be a path the bridge
 * has seen before, so these are the only values worth suggesting - and the
 * directory someone worked in last is the one they most likely want again.
 */
internal fun knownWorkingDirectories(agents: List<Agent>): List<String> = agents
    .filter { !it.cwd.isNullOrBlank() }
    .sortedByDescending { runCatching { Instant.parse(it.lastSeenAt) }.getOrDefault(Instant.EPOCH) }
    .mapNotNull { it.cwd }
    .distinct()

/** A path shortened to what tells directories apart on a chip - its last two segments. */
internal fun workingDirectoryLabel(path: String): String {
    val segments = path.split('/').filter { it.isNotBlank() }
    return when {
        segments.size <= 2 -> path
        else -> "…/" + segments.takeLast(2).joinToString("/")
    }
}
