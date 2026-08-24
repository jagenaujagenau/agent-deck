package dev.agentdeck.mobile

import dev.agentdeck.shared.AgentEvent

enum class DiffLineKind { Addition, Deletion, Context, Header }

data class AgentDiffLine(
    val kind: DiffLineKind,
    val text: String,
    val oldLine: Int? = null,
    val newLine: Int? = null,
)

data class AgentDiffHunk(val id: String, val createdAt: String, val lines: List<AgentDiffLine>)

data class AgentFileChange(
    val path: String,
    val hunks: List<AgentDiffHunk>,
    val additions: Int,
    val deletions: Int,
) {
    /** Runtimes that emit bare `-`/`+` pairs carry no positions; the gutter stays off for those. */
    val hasLineNumbers: Boolean = hunks.any { hunk -> hunk.lines.any { it.oldLine != null || it.newLine != null } }
    val lineCount: Int = hunks.sumOf { it.lines.size }
}

internal fun agentFileChanges(events: List<AgentEvent>): List<AgentFileChange> = events
    .asSequence()
    .filter { !it.diff.isNullOrBlank() }
    .distinctBy { it.id }
    .sortedBy { it.createdAt }
    .groupBy { it.path?.takeIf(String::isNotBlank) ?: "Unknown file" }
    .map { (path, fileEvents) ->
        val hunks = fileEvents.map { event ->
            AgentDiffHunk(
                id = event.id,
                createdAt = event.createdAt,
                lines = parseDiffLines(event.diff.orEmpty()),
            )
        }
        AgentFileChange(
            path = path,
            hunks = hunks,
            additions = hunks.sumOf { hunk -> hunk.lines.count { it.kind == DiffLineKind.Addition } },
            deletions = hunks.sumOf { hunk -> hunk.lines.count { it.kind == DiffLineKind.Deletion } },
        )
    }
    .sortedBy { it.path.lowercase() }

private val HUNK_HEADER = Regex("""^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@""")

/**
 * Parses one runtime-supplied diff body. Unified diffs get real old/new line numbers tracked across
 * their `@@` hunk headers; synthetic `- old` / `+ new` bodies parse into the same shape without them.
 */
internal fun parseDiffLines(diff: String): List<AgentDiffLine> {
    var oldLine: Int? = null
    var newLine: Int? = null
    var started = false
    return diff.lines().map { raw ->
        val hunkHeader = HUNK_HEADER.find(raw)
        when {
            hunkHeader != null -> {
                oldLine = hunkHeader.groupValues[1].toIntOrNull()
                newLine = hunkHeader.groupValues[2].toIntOrNull()
                started = true
                AgentDiffLine(DiffLineKind.Header, raw)
            }
            // File preamble only counts as a header before the first hunk; afterwards `---` is content.
            !started && (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw == "---" || raw == "+++") ->
                AgentDiffLine(DiffLineKind.Header, raw)
            raw.startsWith("\\") -> AgentDiffLine(DiffLineKind.Context, raw.removePrefix("\\").trim())
            raw.startsWith("+") -> {
                val at = newLine
                newLine = at?.plus(1)
                AgentDiffLine(DiffLineKind.Addition, raw.drop(1).removePrefix(" "), newLine = at)
            }
            raw.startsWith("-") -> {
                val at = oldLine
                oldLine = at?.plus(1)
                AgentDiffLine(DiffLineKind.Deletion, raw.drop(1).removePrefix(" "), oldLine = at)
            }
            else -> {
                val oldAt = oldLine
                val newAt = newLine
                oldLine = oldAt?.plus(1)
                newLine = newAt?.plus(1)
                AgentDiffLine(DiffLineKind.Context, raw.removePrefix(" "), oldLine = oldAt, newLine = newAt)
            }
        }
    }
}

/** The trailing context of `@@ -1,4 +1,6 @@ fun render()`, shown instead of the raw range markers. */
internal fun hunkHeaderContext(text: String): String? = text
    .substringAfter("@@", "")
    .substringAfter("@@", "")
    .trim()
    .takeIf { it.isNotEmpty() }
