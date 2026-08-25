package dev.agentdeck.mobile

import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.SlashCommand
import java.time.Duration
import java.time.Instant

internal enum class ConversationRole { User, Agent }

internal data class ConversationEntry(
    val event: AgentEvent,
    val role: ConversationRole,
    val content: String,
)

internal fun conversationEntries(events: List<AgentEvent>): List<ConversationEntry> {
    val entries = events.sortedBy { it.createdAt }.mapNotNull { event ->
        val userMessage = event.summary.startsWith("Remote command:") || event.kind == "user" ||
            (event.kind == "thought" && event.summary == "Received instruction")
        val agentResponse = isAgentResponse(event)
        when {
            userMessage && !event.detail.isNullOrBlank() -> ConversationEntry(event, ConversationRole.User, event.detail.orEmpty().trim())
            agentResponse -> (event.detail ?: event.summary).trim().takeIf { it.isNotBlank() }
                ?.let { ConversationEntry(event, ConversationRole.Agent, it) }
            else -> null
        }
    }
    return entries.fold(mutableListOf()) { result, entry ->
        val previous = result.lastOrNull()
        val duplicateRemoteDelivery = previous?.role == ConversationRole.User && entry.role == ConversationRole.User &&
            previous.content == entry.content && closeInTime(previous.event.createdAt, entry.event.createdAt)
        if (!duplicateRemoteDelivery) result += entry
        result
    }
}

/**
 * The session view's event source: the bridge's retained history plus anything the live snapshot
 * has that has not been fetched yet. The live copy wins on id, since an event can be revised after
 * it is first published (a tool's diff arrives with its completion).
 */
internal fun mergeSessionEvents(history: List<AgentEvent>, live: List<AgentEvent>): List<AgentEvent> {
    if (history.isEmpty()) return live
    val byId = LinkedHashMap<String, AgentEvent>(history.size + live.size)
    for (event in history) byId[event.id] = event
    for (event in live) {
        val known = byId[event.id]
        // The live copy is fresher and normally wins, but the snapshot is a lossy view of the same
        // event: it clips `detail` so a card stays small, and drops `command` and `diff` outright.
        // Taking it wholesale replaces a whole message with its first 400 characters, and strips
        // the command off a terminal entry - which then fails the Terminal tab's filter and
        // disappears from the list entirely.
        byId[event.id] = if (known == null) {
            event
        } else {
            event.copy(
                detail = if (isClippedForm(event.detail, known.detail)) known.detail else event.detail,
                command = event.command ?: known.command,
                diff = event.diff ?: known.diff,
            )
        }
    }
    return byId.values.sortedBy { it.createdAt }
}

/**
 * Whether `live` is the snapshot's shortened form of `full`.
 *
 * The snapshot cuts `detail` and marks the cut with an ellipsis, so its text is a prefix of what
 * history holds. Restoring only that exact shape leaves a genuine revision alone — an event whose
 * text was rewritten to something shorter still takes the live copy.
 */
private fun isClippedForm(live: String?, full: String?): Boolean {
    if (live == null || full == null || !live.endsWith('\u2026')) return false
    return full.length > live.length && full.startsWith(live.dropLast(1).trimEnd())
}

internal fun terminalEvents(events: List<AgentEvent>): List<AgentEvent> =
    events.sortedBy { it.createdAt }.filter { !it.command.isNullOrBlank() }

internal fun reasoningEvents(events: List<AgentEvent>): List<AgentEvent> =
    events.sortedBy { it.createdAt }.filter {
        it.kind == "thought" && it.summary != "Received instruction" && !it.detail.isNullOrBlank()
    }

/**
 * The `/` picker's query, or null when the caret is not in a command token. Only a leading `/` with
 * no whitespace after it counts: once the user types an argument they are writing a message, not
 * still choosing a command.
 */
internal fun slashCommandQuery(input: String): String? {
    if (!input.startsWith("/")) return null
    val token = input.drop(1)
    return if (token.any(Char::isWhitespace)) null else token
}

/** Commands matching the query, name matches first, then description matches. */
internal fun matchSlashCommands(query: String, commands: List<SlashCommand>, limit: Int = 30): List<SlashCommand> {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return commands.take(limit)
    val byName = commands.filter { it.name.lowercase().contains(needle) }
    val byDescription = commands.filter { command ->
        command !in byName && command.description?.lowercase()?.contains(needle) == true
    }
    return (byName.sortedBy { if (it.name.lowercase().startsWith(needle)) 0 else 1 } + byDescription).take(limit)
}

internal fun remoteMessageAction(state: String, supports: (String) -> Boolean): String? = when {
    state in listOf("running", "waiting") && supports("steer") -> "steer"
    state in listOf("running", "waiting") && supports("follow_up") -> "follow_up"
    supports("prompt") -> "prompt"
    supports("follow_up") -> "follow_up"
    else -> null
}

internal fun terminalCommandInstruction(command: String): String {
    val exact = command.trim()
    val longestBacktickRun = Regex("`+").findAll(exact).maxOfOrNull { it.value.length } ?: 0
    val fence = "`".repeat(maxOf(3, longestBacktickRun + 1))
    return "Run this exact shell command using the runtime's shell tool. Do not alter it:\n\n${fence}sh\n$exact\n$fence"
}

internal sealed interface ResponseBlock {
    data class Markdown(val content: String) : ResponseBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : ResponseBlock
}

internal fun responseBlocks(content: String): List<ResponseBlock> {
    val lines = restoreFlattenedMarkdown(content).lines()
    val blocks = mutableListOf<ResponseBlock>()
    var textStart = 0
    var index = 1
    while (index < lines.size) {
        val separators = tableCells(lines[index])
        val headers = tableCells(lines[index - 1])
        val isSeparator = separators.size >= 2 && separators.all { it.matches(Regex(""":?-{3,}:?""")) }
        if (!isSeparator || headers.size != separators.size) {
            index += 1
            continue
        }
        lines.subList(textStart, index - 1).joinToString("\n").trim().takeIf(String::isNotBlank)?.let { blocks += ResponseBlock.Markdown(it) }
        val rows = mutableListOf<List<String>>()
        var rowIndex = index + 1
        while (rowIndex < lines.size) {
            val cells = tableCells(lines[rowIndex])
            if (cells.isEmpty()) break
            // Markdown pads short rows and ignores extra cells; requiring an exact match silently
            // truncated a table at its first ragged row.
            rows += List(headers.size) { column -> cells.getOrElse(column) { "" } }
            rowIndex += 1
        }
        blocks += ResponseBlock.Table(headers, rows)
        textStart = rowIndex
        index = rowIndex + 1
    }
    lines.subList(textStart, lines.size).joinToString("\n").trim().takeIf(String::isNotBlank)?.let { blocks += ResponseBlock.Markdown(it) }
    return blocks.ifEmpty { listOf(ResponseBlock.Markdown(content)) }
}

private fun tableCells(line: String): List<String> {
    val trimmed = line.trim()
    // A lone "|" starts and ends with a pipe but delimits nothing; without this it would be read
    // as a one-empty-cell row and absorbed into whatever table precedes it.
    if (trimmed.length < 2 || !trimmed.startsWith('|') || !trimmed.endsWith('|')) return emptyList()
    // Split on unescaped pipes only: a cell may legitimately contain `\|`, and splitting on it
    // gives the row more cells than the table has columns, which used to drop the row entirely.
    val cells = mutableListOf<String>()
    val cell = StringBuilder()
    var index = 1
    val end = trimmed.length - 1
    while (index < end) {
        val character = trimmed[index]
        when {
            character == '\\' && index + 1 < end && trimmed[index + 1] == '|' -> { cell.append('|'); index += 2 }
            character == '|' -> { cells += cell.toString().trim(); cell.clear(); index += 1 }
            else -> { cell.append(character); index += 1 }
        }
    }
    cells += cell.toString().trim()
    return cells
}

/** Repairs historical responses flattened before Markdown-safe ingestion was introduced. */
internal fun restoreFlattenedMarkdown(content: String): String {
    if ('\n' in content || "| |" !in content) return content
    val lines = content.replace(Regex("""\|\s+\|"""), "|\n|").lines().toMutableList()
    var separatorIndex = 1
    var repairedTable = false
    while (separatorIndex < lines.size) {
        val separators = lines[separatorIndex].trim().trim('|').split('|').map(String::trim)
        if (separators.size < 2 || !separators.all { it.matches(Regex(""":?-{3,}:?""")) }) {
            separatorIndex += 1
            continue
        }
        val columns = separators.size
        val headerIndex = separatorIndex - 1
        val header = lines[headerIndex]
        val headerBars = header.indices.filter { header[it] == '|' }
        if (headerBars.size < columns + 1) {
            separatorIndex += 1
            continue
        }
        val tableStart = headerBars[headerBars.size - columns - 1]
        val prefix = restoreFlattenedHeadings(header.substring(0, tableStart).trimEnd())
        val tableHeader = "| " + header.substring(tableStart + 1).trimStart()
        if (prefix.isBlank()) {
            lines[headerIndex] = tableHeader
        } else {
            lines.removeAt(headerIndex)
            lines.addAll(headerIndex, listOf(prefix, "", tableHeader))
            separatorIndex += 2
        }
        repairedTable = true

        var rowIndex = separatorIndex + 1
        while (rowIndex < lines.size) {
            val row = lines[rowIndex]
            if (!row.trimStart().startsWith('|')) break
            val bars = row.indices.filter { row[it] == '|' }
            if (bars.size < columns + 1) break
            val closingBar = bars[columns]
            val trailing = row.substring(closingBar + 1).trim()
            lines[rowIndex] = row.substring(0, closingBar + 1)
            if (trailing.isNotBlank()) {
                lines.addAll(rowIndex + 1, listOf("", restoreFlattenedHeadings(trailing)))
                break
            }
            rowIndex += 1
        }
        separatorIndex += 1
    }
    return if (repairedTable) lines.joinToString("\n") else content
}

private fun restoreFlattenedHeadings(value: String): String =
    value.replace(Regex("""\s+(?=#{1,6}\s)"""), "\n\n")

private fun isAgentResponse(event: AgentEvent) = event.kind == "output" && !event.summary.startsWith("Remote command:") && event.tool == null && event.command == null &&
    (event.summary == "Response" || !event.detail.isNullOrBlank() || (event.summary != "Activity" && !event.summary.endsWith(" completed")))

private fun closeInTime(first: String, second: String): Boolean = runCatching {
    Duration.between(Instant.parse(first), Instant.parse(second)).abs() < Duration.ofSeconds(10)
}.getOrDefault(false)
