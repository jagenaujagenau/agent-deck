package dev.agentdeck.mobile

import androidx.compose.ui.unit.dp
import dev.agentdeck.shared.DeckSummaries
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * How many sessions the widget draws at the sizes it is actually placed at.
 *
 * The bug this guards against is the one that got reported: a card sized for
 * several rows that drew none, because it only ever listed sessions asking for
 * attention and none were.
 */
class DeckWidgetSizeTest {
    @Test
    fun `a tall widget fills with sessions`() {
        // Roughly the four-by-three placement on the home screen.
        assertTrue(rowsThatFit(280.dp) >= 5)
    }

    @Test
    fun `a short widget still shows something under the header`() {
        assertTrue(rowsThatFit(110.dp) >= 1)
    }

    @Test
    fun `a widget too small for any row asks for none rather than a negative`() {
        assertEquals(0, rowsThatFit(20.dp))
        assertEquals(0, rowsThatFit(0.dp))
    }

    @Test
    fun `no more rows are asked for than the summary can hold`() {
        // A very tall placement must not ask for lines that were never stored.
        assertEquals(DeckSummaries.MAX_LINES, rowsThatFit(2_000.dp))
    }
}
