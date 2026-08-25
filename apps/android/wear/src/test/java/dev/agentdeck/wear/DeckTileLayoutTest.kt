package dev.agentdeck.wear

import androidx.wear.protolayout.LayoutElementBuilders
import dev.agentdeck.shared.DeckSummary
import dev.agentdeck.shared.DeckLine
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

    private fun summary(attention: Int, needing: List<DeckLine>, running: Int = 0) = DeckSummary(
        lines = needing,
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
                        DeckLine("a1", "fx-ruby", "Approval: Bash", needsYou = true),
                        DeckLine("a2", "nametags", "Which branch?", needsYou = true),
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
                    needing = listOf(DeckLine("a1", "fx-ruby", "Approval: Bash", needsYou = true)),
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
            summary(attention = 1, needing = listOf(DeckLine("a1", "fx-ruby", "Approval: Bash", needsYou = true)))
                .let(::layout),
        )
        assertTrue(rendered.none { it.endsWith("more") })
    }

    @Test
    fun `a resting deck shows what is working rather than an empty circle`() {
        val rendered = texts(
            layout(
                summary(
                    attention = 0,
                    needing = listOf(DeckLine("a1", "fx-lisp", "Using Bash")),
                    running = 2,
                ),
            ),
        )
        assertEquals("2 working", rendered.first())
        // The headline alone under a round face is the emptiness this fixes.
        assertTrue(rendered.contains("fx-lisp"))
        assertTrue(rendered.contains("Using Bash"))
    }

    @Test
    fun `a tile that has never reached the bridge admits it`() {
        // The state before the first relay. "No sessions" here would be a
        // confident lie about a deck the watch has never seen.
        assertEquals("Not connected", texts(layout(DeckSummary())).first())
    }
}
