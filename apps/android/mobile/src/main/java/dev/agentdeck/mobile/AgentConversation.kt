package dev.agentdeck.mobile

import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.ConversationEntry
import dev.agentdeck.shared.ConversationRole
import dev.agentdeck.shared.conversationEntries
import dev.agentdeck.shared.mergeSessionEvents
import dev.agentdeck.shared.reasoningEvents
import dev.agentdeck.shared.remoteMessageAction
import dev.agentdeck.shared.SlashCommand
import java.time.Duration
import java.time.Instant

internal fun terminalEvents(events: List<AgentEvent>): List<AgentEvent> =
    events.sortedBy { it.createdAt }.filter { !it.command.isNullOrBlank() }

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

private fun closeInTime(first: String, second: String): Boolean = runCatching {
    Duration.between(Instant.parse(first), Instant.parse(second)).abs() < Duration.ofSeconds(10)
}.getOrDefault(false)
