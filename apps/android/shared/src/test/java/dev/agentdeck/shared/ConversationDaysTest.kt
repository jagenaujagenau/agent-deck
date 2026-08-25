package dev.agentdeck.shared

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationDaysTest {
    private val utc = ZoneId.of("UTC")
    private val today = LocalDate.of(2026, 8, 25)

    private fun before(previous: String?, current: String) =
        ConversationDays.separatorBefore(previous, current, today, utc)

    @Test
    fun `the first message always carries its date`() {
        // Opening a conversation with no date leaves the reader guessing
        // whether it started today.
        assertEquals("Today", before(null, "2026-08-25T09:00:00Z"))
    }

    @Test
    fun `messages on the same day are not separated`() {
        assertNull(before("2026-08-25T09:00:00Z", "2026-08-25T23:59:00Z"))
    }

    @Test
    fun `crossing midnight draws a separator`() {
        // The timestamps only say the hour, so "09:14" under "23:47" reads as
        // four minutes later rather than ten hours.
        assertEquals("Today", before("2026-08-24T23:47:00Z", "2026-08-25T09:14:00Z"))
    }

    @Test
    fun `recent days are named, not dated`() {
        assertEquals("Yesterday", ConversationDays.label(LocalDate.of(2026, 8, 24), today))
        assertEquals("Today", ConversationDays.label(today, today))
    }

    @Test
    fun `older days in this year need no year`() {
        assertEquals("3 August", ConversationDays.label(LocalDate.of(2026, 8, 3), today))
    }

    @Test
    fun `a different year earns its space`() {
        assertEquals("30 December 2025", ConversationDays.label(LocalDate.of(2025, 12, 30), today))
    }

    @Test
    fun `an unparseable timestamp draws nothing rather than guessing`() {
        assertNull(before(null, "not-a-time"))
    }

    @Test
    fun `the zone decides the day, not the instant`() {
        // 23:30 UTC is already tomorrow in Tokyo; a person reads their own clock.
        val tokyo = ZoneId.of("Asia/Tokyo")
        assertEquals(
            "Today",
            ConversationDays.separatorBefore(null, "2026-08-24T23:30:00Z", today, tokyo),
        )
    }
}
