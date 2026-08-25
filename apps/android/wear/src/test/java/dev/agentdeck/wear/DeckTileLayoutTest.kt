package dev.agentdeck.wear

import androidx.wear.protolayout.LayoutElementBuilders
import dev.agentdeck.shared.DeckSummary
import dev.agentdeck.shared.DeckLine
import dev.agentdeck.shared.Harness
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
        is LayoutElementBuilders.Row -> element.contents.flatMap { texts(it) }
        is LayoutElementBuilders.Box -> element.contents.flatMap { texts(it) }
        else -> emptyList()
    }

    /** The rendered strings with the prompt and markers stripped, for comparing. */
    private fun lines(element: LayoutElementBuilders.LayoutElement): List<String> =
        texts(element).map { it.trim() }.filter { line ->
            line.isNotEmpty() && line != "❯" && Harness.entries.none { it.mark == line }
        }

    /** A 45mm round watch, which is what these are drawn for. */
    private val ROUND = Screen(widthDp = 227f, heightDp = 227f, round = true)

    private fun layoutOn(summary: DeckSummary) = layout(summary, ROUND)

    private fun summary(attention: Int, needing: List<DeckLine>, running: Int = 0) = DeckSummary(
        lines = needing,
        attention = attention,
        running = running,
        observedAt = 1L,
        reachedBridge = true,
    )

    @Test
    fun `the count comes first and is the real one`() {
        val rendered = lines(
            layoutOn(summary(
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
        val rendered = lines(
            layoutOn(summary(
                    attention = 5,
                    needing = listOf(DeckLine("a1", "fx-ruby", "Approval: Bash", needsYou = true)),
                ),
            ),
        )
        // Five waiting, one shown. Saying nothing would report the other four
        // as fine.
        assertTrue(rendered.contains("… 4 more"))
    }

    @Test
    fun `nothing is left over when everything fits`() {
        val rendered = lines(
            summary(attention = 1, needing = listOf(DeckLine("a1", "fx-ruby", "Approval: Bash", needsYou = true)))
                .let(::layoutOn),
        )
        assertTrue(rendered.none { it.endsWith("more") })
    }

    @Test
    fun `a resting deck shows what is working rather than an empty circle`() {
        val rendered = lines(
            layoutOn(summary(
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
        assertEquals("Not connected", lines(layout(DeckSummary(), ROUND)).first())
    }
}

class DeckTileGeometryTest {
    private val round = Screen(widthDp = 227f, heightDp = 227f, round = true)
    private val square = Screen(widthDp = 227f, heightDp = 227f, round = false)

    @Test
    fun `a round screen keeps text further from the edge than a square one`() {
        // There are no corners to write into on a circle, and the headline and
        // the overflow line are exactly where the curve bites.
        assertTrue(horizontalInset(round) > horizontalInset(square))
    }

    @Test
    fun `the inset leaves most of the width to write in`() {
        val usable = round.widthDp - 2 * horizontalInset(round)
        assertTrue("usable width was $usable", usable > round.widthDp * 0.6f)
    }

    @Test
    fun `a small round face shows a glance, not a list`() {
        assertTrue(rowsThatFit(round) in 1..3)
    }

    @Test
    fun `a square face may show more, since it has the corners`() {
        assertTrue(rowsThatFit(square) >= rowsThatFit(round))
    }
}

class DeckTileHarnessTest {
    private val round = Screen(widthDp = 227f, heightDp = 227f, round = true)

    /** Every image the tile asks the system to draw, by the name it asks for. */
    private fun images(element: LayoutElementBuilders.LayoutElement): List<String> =
        when (element) {
            is LayoutElementBuilders.Image -> listOf(element.resourceId?.value.orEmpty())
            is LayoutElementBuilders.Column -> element.contents.flatMap { images(it) }
            is LayoutElementBuilders.Row -> element.contents.flatMap { images(it) }
            is LayoutElementBuilders.Box -> element.contents.flatMap { images(it) }
            else -> emptyList()
        }

    private fun texts(element: LayoutElementBuilders.LayoutElement): List<String> = when (element) {
        is LayoutElementBuilders.Text -> listOf(element.text?.value.orEmpty())
        is LayoutElementBuilders.Column -> element.contents.flatMap { texts(it) }
        is LayoutElementBuilders.Row -> element.contents.flatMap { texts(it) }
        is LayoutElementBuilders.Box -> element.contents.flatMap { texts(it) }
        else -> emptyList()
    }

    private fun deckOf(vararg lines: DeckLine) = DeckSummary(
        lines = lines.toList(),
        running = lines.size,
        reachedBridge = true,
    )

    @Test
    fun `a runtime with a mark of its own has it drawn`() {
        val rendered = images(
            layout(
                deckOf(
                    DeckLine("claude-a", "fx-ruby", "Weighing two approaches", Harness.Claude),
                    DeckLine("opencode-b", "ai-2026", "Read the file", Harness.OpenCode),
                ),
                round,
            ),
        )
        // Named by the enum entry, which is the same key the resources are
        // registered under - a mismatch here draws nothing at all.
        assertTrue("saw $rendered", rendered.contains(Harness.Claude.name))
        assertTrue("saw $rendered", rendered.contains(Harness.OpenCode.name))
    }

    @Test
    fun `every drawn image is one the tile actually registers`() {
        val rendered = images(
            layout(deckOf(DeckLine("claude-a", "fx", "thinking", Harness.Claude)), round),
        )
        val registered = Harness.entries.filter { it.icon != null }.map { it.name }
        assertTrue("$rendered not all in $registered", registered.containsAll(rendered))
    }

    @Test
    fun `a runtime with no mark falls back to its monogram`() {
        // An empty badge would say the session has no harness, which is never
        // what is meant.
        val pi = deckOf(DeckLine("01a02e7b", "agent-control-dashboard", "Working", Harness.Pi))
        assertTrue(images(layout(pi, round)).isEmpty())
        assertTrue(texts(layout(pi, round)).map { it.trim() }.contains(Harness.Pi.mark))
    }
}
