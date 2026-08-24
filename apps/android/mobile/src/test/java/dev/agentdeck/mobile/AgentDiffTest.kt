package dev.agentdeck.mobile

import dev.agentdeck.shared.AgentEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentDiffTest {
    @Test
    fun groupsChangesByFileAndCountsRealAddedAndDeletedLines() {
        val events = listOf(
            event("two", "src/B.kt", "- old\n+ new\n+ another", "2026-08-24T10:00:02Z"),
            event("one", "src/A.kt", "@@ -1 +1 @@\n- before\n+ after", "2026-08-24T10:00:01Z"),
            event("three", "src/A.kt", "+ final", "2026-08-24T10:00:03Z"),
        )

        val files = agentFileChanges(events)

        assertEquals(listOf("src/A.kt", "src/B.kt"), files.map { it.path })
        assertEquals(2, files[0].additions)
        assertEquals(1, files[0].deletions)
        assertEquals(2, files[0].hunks.size)
        assertEquals(DiffLineKind.Header, files[0].hunks.first().lines.first().kind)
    }

    @Test
    fun duplicateEventIdsDoNotDoubleCountBridgeEchoes() {
        val duplicate = event("same", "README.md", "+ line", "2026-08-24T10:00:00Z")
        val file = agentFileChanges(listOf(duplicate, duplicate.copy(summary = "echo"))).single()
        assertEquals(1, file.additions)
        assertEquals(1, file.hunks.size)
    }

    @Test
    fun unifiedHunkHeadersProduceRealOldAndNewLineNumbers() {
        val lines = parseDiffLines("@@ -10,3 +10,4 @@ fun render()\n context\n-gone\n+added\n+also\n tail")

        assertEquals(DiffLineKind.Header, lines[0].kind)
        assertEquals(listOf(10, 11), listOf(lines[1].oldLine, lines[2].oldLine))
        assertEquals(listOf(10, 11, 12, 13), listOf(lines[1].newLine, lines[3].newLine, lines[4].newLine, lines[5].newLine))
        // The deletion consumes an old line only; the additions consume new lines only.
        assertEquals(null, lines[3].oldLine)
        assertEquals(null, lines[2].newLine)
        // Old-side numbering skipped the addition, so the trailing context sits at old line 12.
        assertEquals(12, lines[5].oldLine)
    }

    @Test
    fun secondHunkHeaderRestartsNumberingAtItsOwnRange() {
        val lines = parseDiffLines("@@ -1,1 +1,1 @@\n+one\n@@ -80,2 +90,2 @@\n+two")

        assertEquals(1, lines[1].newLine)
        assertEquals(90, lines[3].newLine)
    }

    @Test
    fun syntheticRuntimeDiffsWithoutHeadersCarryNoLineNumbers() {
        val file = agentFileChanges(listOf(event("one", "src/A.kt", "- old\n+ new", "2026-08-24T10:00:00Z"))).single()

        assertEquals(false, file.hasLineNumbers)
        assertEquals(2, file.lineCount)
    }

    @Test
    fun contentDashesAfterAHunkHeaderAreDeletionsNotFilePreamble() {
        val lines = parseDiffLines("@@ -1,2 +1,1 @@\n--- a legend row\n+kept")

        assertEquals(DiffLineKind.Deletion, lines[1].kind)
        assertEquals("-- a legend row", lines[1].text)
    }

    @Test
    fun hunkHeaderContextExposesTheTrailingSymbolName() {
        assertEquals("fun render()", hunkHeaderContext("@@ -10,3 +10,4 @@ fun render()"))
        assertEquals(null, hunkHeaderContext("@@ -10,3 +10,4 @@"))
        assertEquals(null, hunkHeaderContext("--- a/src/A.kt"))
    }

    private fun event(id: String, path: String, diff: String, createdAt: String) = AgentEvent(
        id = id,
        kind = "output",
        summary = "edit completed",
        createdAt = createdAt,
        tool = "edit",
        path = path,
        diff = diff,
    )
}