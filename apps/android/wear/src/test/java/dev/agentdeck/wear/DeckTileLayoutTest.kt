package dev.agentdeck.wear

import androidx.wear.protolayout.LayoutElementBuilders
import dev.agentdeck.shared.DeckSummary
import dev.agentdeck.shared.NeedsYou
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tile's rendering, checked without a watch.
 *
 * A screenshot proves a tile drew once; this proves what it says for states the
 * deck is rarely in when someone happens to be looking - five waiting when only
 * two fit, or nothing reached at all.
 */
class DeckTileLayoutTest {
    /** Every string the tile would render, in order. */
    private fun texts(element: LayoutElementBuilders.LayoutElement): List<String> = when (element) {
        is LayoutElementBuilders.Text -> listOf(element.text?.value.orEmpty())
        is LayoutElementBuilders.Column -> element.contents.flatMap { texts(it) }
        else -> emptyList()
    }

    private fun summary(attention: Int, needing: List<NeedsYou>, running: Int = 0) = DeckSummary(
        needing = needing,
        attention = attention,
        running = running,
        observedAt = 1L,
        reachedBridge = true,
    )

    @Test
    fun `the count comes first and is the real one`() {
        val rendered = texts(
            layout(
                summary(
                    attention = 5,
                    needing = listOf(
                        NeedsYou("a1", "fx-ruby", "Approval: Bash"),
                        NeedsYou("a2", "nametags", "Which branch?"),
                    ),
                ),
            ),
        )
        assertEquals("5 need you", rendered.first())
        assertTrue(rendered.contains("fx-ruby"))
        assertTrue(rendered.contains("Approval: Bash"))
    }

    @Test
    fun `what did not fit is stated, never silently dropped`() {
        val rendered = texts(
            layout(
                summary(
                    attention = 5,
                    needing = listOf(NeedsYou("a1", "fx-ruby", "Approval: Bash")),
                ),
            ),
        )
        // Five waiting, one shown. Saying nothing would report the other four
        // as fine.
        assertTrue(rendered.contains("and 4 more"))
    }

    @Test
    fun `nothing is left over when everything fits`() {
        val rendered = texts(
            summary(attention = 1, needing = listOf(NeedsYou("a1", "fx-ruby", "Approval: Bash")))
                .let(::layout),
        )
        assertTrue(rendered.none { it.endsWith("more") })
    }

    @Test
    fun `a resting deck says what it is doing rather than zero`() {
        val rendered = texts(layout(summary(attention = 0, needing = emptyList(), running = 2)))
        assertEquals("2 working", rendered.first())
        assertEquals(1, rendered.size)
    }

    @Test
    fun `a tile that has never reached the bridge admits it`() {
        // The state before the first relay. "No sessions" here would be a
        // confident lie about a deck the watch has never seen.
        assertEquals("Not connected", texts(layout(DeckSummary())).first())
    }
}
