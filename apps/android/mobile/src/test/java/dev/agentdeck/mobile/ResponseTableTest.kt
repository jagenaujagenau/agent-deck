package dev.agentdeck.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponseTableTest {
    @Test
    fun `a table with an empty leading header cell still parses`() {
        // Exactly as it arrives from the transcript, including the blank corner cell.
        val content = """
            Measured over 30 seconds:

            | | before today | now |
            |---|---|---|
            | 27 stream updates | 27 × 596 KB | 292 KB |
            | per update | 596 KB | ~7 KB |

            That is the whole change.
        """.trimIndent()

        val blocks = responseBlocks(content)
        val table = blocks.filterIsInstance<ResponseBlock.Table>().singleOrNull()
        assertTrue("expected one table, got ${blocks.map { it::class.simpleName }}", table != null)
        assertEquals(listOf("", "before today", "now"), table!!.headers)
        assertEquals(2, table.rows.size)
        assertEquals(listOf("per update", "596 KB", "~7 KB"), table.rows[1])
        // The prose on either side must survive as its own blocks.
        assertEquals(2, blocks.filterIsInstance<ResponseBlock.Markdown>().size)
    }

    @Test
    fun `padded pipes and alignment markers parse`() {
        val content = """
            | Feature | State |
            | :------ | ----: |
            | Chat    | done  |
        """.trimIndent()

        val table = responseBlocks(content).filterIsInstance<ResponseBlock.Table>().single()
        assertEquals(listOf("Feature", "State"), table.headers)
        assertEquals(listOf(listOf("Chat", "done")), table.rows)
    }

    @Test
    fun `a table that ends the message needs no trailing blank line`() {
        val content = "Summary:\n\n| a | b |\n|---|---|\n| 1 | 2 |"

        val table = responseBlocks(content).filterIsInstance<ResponseBlock.Table>().single()
        assertEquals(listOf(listOf("1", "2")), table.rows)
    }

    @Test
    fun `a row with a trailing empty cell is not dropped`() {
        // `| a | b | |` has three cells, the last empty — a common shape when a column is N/A.
        val content = "| a | b | c |\n|---|---|---|\n| 1 | 2 | |"

        val table = responseBlocks(content).filterIsInstance<ResponseBlock.Table>().single()
        assertEquals(listOf(listOf("1", "2", "")), table.rows)
    }

    @Test
    fun `cells containing escaped pipes do not split the row`() {
        val content = "| code | meaning |\n|---|---|\n| `a \\| b` | either |"

        val table = responseBlocks(content).filterIsInstance<ResponseBlock.Table>().single()
        assertEquals(listOf(listOf("`a | b`", "either")), table.rows)
    }

    @Test
    fun `a short row is padded rather than truncating the table`() {
        // A row that omits its last column used to end the table at that point.
        val content = "| a | b | c |\n|---|---|---|\n| 1 | 2 |\n| 3 | 4 | 5 |"

        val table = responseBlocks(content).filterIsInstance<ResponseBlock.Table>().single()
        assertEquals(listOf(listOf("1", "2", ""), listOf("3", "4", "5")), table.rows)
    }

    @Test
    fun `prose after a table is not swallowed by it`() {
        // Single-column tables are deliberately not recognised, so use a real two-column one.
        val content = "| a | b |\n|---|---|\n| 1 | 2 |\n\nAnd then some prose."

        val blocks = responseBlocks(content)
        assertEquals(1, blocks.filterIsInstance<ResponseBlock.Table>().size)
        assertTrue(blocks.filterIsInstance<ResponseBlock.Markdown>().single().content.contains("some prose"))
    }
}
