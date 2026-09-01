package dev.agentdeck.shared

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The rule every clipped surface shares. Its Swift twin is
 * `MarkdownPreviewTests`, and the same cases live in the corpus's `cardText`
 * section — these exist so a failure names the rule rather than the card.
 */
class MarkdownPreviewTest {
    @Test
    fun `markdown preview keeps meaning without formatting syntax`() {
        assertEquals(
            "Plan Read docs before editing",
            stripMarkdownForPreview("# Plan\n\n- Read [docs](https://example.com) before **editing**"),
        )
    }

    @Test
    fun `a table becomes its cells`() {
        assertEquals(
            "pass · frame before · 21 ms",
            stripMarkdownForPreview("| pass | frame |\n|---|---|\n| before | 21 ms |"),
        )
    }

    @Test
    fun `a fenced block is named rather than quoted`() {
        assertEquals("Try: code Done.", stripMarkdownForPreview("Try:\n\n```kotlin\nval a = 1\n```\n\nDone."))
    }

    @Test
    fun `an unclosed fence does not swallow the words before it`() {
        assertEquals("Here it is: code", stripMarkdownForPreview("Here it is:\n\n```sh\nnpm test"))
    }

    @Test
    fun `a task list and a rule leave only what they said`() {
        assertEquals(
            "shipped pending and then this",
            stripMarkdownForPreview("- [x] shipped\n- [ ] pending\n\n---\n\nand then this"),
        )
    }

    @Test
    fun `an identifier with underscores is not emphasis`() {
        assertEquals(
            "Check user_id_lookup before touching the cache",
            stripMarkdownForPreview("Check user_id_lookup before _touching_ the cache"),
        )
    }

    @Test
    fun `a marker preview clips at a word`() {
        assertEquals("one two…", markerPreview("# one two three", limit = 10))
    }
}
