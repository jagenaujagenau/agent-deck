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
    fun `a tall widget fills with session cards`() {
        // Roughly the four-by-three placement on the home screen. A card holds
        // an avatar beside two lines of text, so fewer fit than the single
        // lines this replaced - the number is smaller and still fills.
        assertTrue(rowsThatFit(280.dp) >= 4)
    }

    @Test
    fun `a short widget still shows something under the chrome`() {
        assertTrue(rowsThatFit(110.dp) >= 1)
    }

    @Test
    fun `the size granted is what decides, not the minimum declared`() {
        // Glance reports the provider's minHeight unless the widget asks for
        // SizeMode.Exact, and a card placed with room for six drew one.
        assertTrue(rowsThatFit(300.dp) > rowsThatFit(110.dp))
    }

    @Test
    fun `a widget too small for any row asks for none rather than a negative`() {
        assertEquals(0, rowsThatFit(20.dp))
        assertEquals(0, rowsThatFit(0.dp))
    }

    @Test
    fun `the chrome is paid for before any row is offered`() {
        // Title bar plus prompt line. A row drawn into that space would be
        // clipped by the window it is supposed to be inside.
        assertEquals(0, rowsThatFit(55.dp))
    }

    @Test
    fun `no more rows are asked for than the summary can hold`() {
        // A very tall placement must not ask for lines that were never stored.
        assertEquals(DeckSummaries.MAX_LINES, rowsThatFit(2_000.dp))
    }
}
