package dev.agentdeck.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalTypingTest {
    @Test
    fun `the speed control walks the list and comes back`() {
        var speed = TerminalTypeSpeed.Off
        val seen = buildList { repeat(TerminalTypeSpeed.entries.size) { add(speed); speed = speed.next() } }
        assertEquals(TerminalTypeSpeed.entries.toList(), seen)
        // One control, so it has to return to where it started.
        assertEquals(TerminalTypeSpeed.Off, speed)
    }

    @Test
    fun `a long line and a short one type at the same rate`() {
        // The point of a rate: a paragraph of shell should look like the same
        // terminal working, not the same animation stretched over more text.
        val short = typingDurationMs(10, TerminalTypeSpeed.Normal.charsPerSecond)
        val long = typingDurationMs(100, TerminalTypeSpeed.Normal.charsPerSecond)
        assertEquals(10, long / short)
    }

    @Test
    fun `off means no animation at all, not a very fast one`() {
        assertEquals(0, typingDurationMs(500, TerminalTypeSpeed.Off.charsPerSecond))
    }

    @Test
    fun `an empty line costs nothing`() {
        assertEquals(0, typingDurationMs(0, TerminalTypeSpeed.Fast.charsPerSecond))
    }

    @Test
    fun `even one character gets a frame to show in`() {
        // Rounding a single character to zero would make it appear whole, which
        // is the one case where the effect is most visible as a glitch.
        assertTrue(typingDurationMs(1, TerminalTypeSpeed.Fast.charsPerSecond) >= 16)
    }

    @Test
    fun `slow is slower than fast, which is the only ordering that matters`() {
        val slow = typingDurationMs(100, TerminalTypeSpeed.Slow.charsPerSecond)
        val normal = typingDurationMs(100, TerminalTypeSpeed.Normal.charsPerSecond)
        val fast = typingDurationMs(100, TerminalTypeSpeed.Fast.charsPerSecond)
        assertTrue(slow > normal && normal > fast)
    }
}
