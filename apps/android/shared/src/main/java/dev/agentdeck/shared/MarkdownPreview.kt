package dev.agentdeck.shared

/**
 * Markdown reduced to the plain words a one-line surface can hold.
 *
 * Anywhere a message is clipped - a card's preview line, a notification body,
 * a widget row, a watch tile, a conversation-map marker - the reader gets one
 * line and no way to open the dressing back up. Markdown left in it does not
 * decorate anything there: a heading arrives as "## Findings", a table as a
 * row of pipes, a fenced block as three backticks and its first statement.
 * Every clipped surface goes through here first.
 *
 * Fenced code is named rather than quoted: "code" tells the reader what was
 * said far better than the first eighty characters of it. Mirrored in Swift as
 * `stripMarkdownForPreview` in `ChatSummary.swift`, and pinned by the corpus's
 * `cardText` section.
 */
fun stripMarkdownForPreview(markdown: String): String {
    var value = markdown
        .replace(Regex("""```[\s\S]*?(```|$)"""), " code ")
        .lineSequence()
        .map(::withoutBlockMarkers)
        .filter(String::isNotBlank)
        .joinToString(" ")
        .replace(Regex("""!\[([^]]*)]\([^)]*\)"""), "$1")
        .replace(Regex("""\[([^]]+)]\([^)]*\)"""), "$1")
        .replace(Regex("""`([^`]*)`"""), "$1")
        .replace(Regex("""<[^>]+>"""), " ")
    // Twice, for the nested bold-italic an agent writes without thinking.
    // Underscores need a word boundary on both ends: `user_id_lookup` is a
    // name a preview should print whole, not emphasis around "id".
    repeat(2) {
        value = value
            .replace(Regex("""\*\*(.*?)\*\*"""), "$1")
            .replace(Regex("""\*(.*?)\*"""), "$1")
            .replace(Regex("""(?<![A-Za-z0-9])__(.+?)__(?![A-Za-z0-9])"""), "$1")
            .replace(Regex("""(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])"""), "$1")
            .replace(Regex("""~~(.*?)~~"""), "$1")
    }
    return value.replace(Regex("""\s+"""), " ").trim()
}

/** A rule row, a thematic break, and the markers that open a line. */
private fun withoutBlockMarkers(line: String): String {
    val trimmed = line.trim()
    // A table's rule row and a horizontal rule are pure punctuation: they say
    // nothing once the shape they belong to is gone.
    if (trimmed.matches(Regex("""\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?"""))) return ""
    if (trimmed.matches(Regex("""([-*_])\s*(\1\s*){2,}"""))) return ""
    val text = trimmed
        .replace(Regex("""^(?:#{1,6}|>|[-+*]|\d+[.)])\s+"""), "")
        // The checkbox of a task item, once its bullet is gone.
        .replace(Regex("""^\[[ xX]]\s+"""), "")
    // A table row reads as its cells, separated the way the deck separates
    // anything else on one line.
    if (text.length >= 2 && text.startsWith("|") && text.endsWith("|")) {
        return text.trim('|').split('|').joinToString(" · ") { it.trim() }.trim()
    }
    return text
}

/** One line's worth, cut at a word rather than mid-syllable. */
fun clipAtWord(value: String, limit: Int): String {
    if (value.length <= limit) return value
    val clipped = value.take((limit - 1).coerceAtLeast(0)).trimEnd()
    return "${clipped.substringBeforeLast(' ', clipped)}…"
}
