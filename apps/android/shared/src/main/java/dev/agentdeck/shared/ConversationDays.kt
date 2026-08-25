package dev.agentdeck.shared

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Where a conversation crosses from one day into the next.
 *
 * A session that has been open since yesterday reads as one unbroken run of
 * messages, and the timestamps only say the hour - so "09:14" above "23:47"
 * looks like a reply four minutes later rather than ten hours.
 */
object ConversationDays {
    private val dayFormatter = DateTimeFormatter.ofPattern("d MMMM")
    private val withYear = DateTimeFormatter.ofPattern("d MMMM yyyy")

    private fun dayOf(iso: String, zone: ZoneId): LocalDate? =
        runCatching { Instant.parse(iso).atZone(zone).toLocalDate() }.getOrNull()

    /**
     * The label to draw above this message, or nothing when it belongs to the
     * same day as the one before it.
     *
     * The first message always carries one: a conversation opening with no date
     * leaves the reader guessing whether it started today.
     */
    fun separatorBefore(
        previous: String?,
        current: String,
        today: LocalDate = LocalDate.now(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): String? {
        val day = dayOf(current, zone) ?: return null
        if (previous != null && dayOf(previous, zone) == day) return null
        return label(day, today)
    }

    /** How a person names a day: by its distance from now, then by its date. */
    fun label(day: LocalDate, today: LocalDate = LocalDate.now()): String = when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        // The year only earns its space once it is no longer the obvious one.
        else -> if (day.year == today.year) dayFormatter.format(day) else withYear.format(day)
    }
}
