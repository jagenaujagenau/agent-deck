package dev.agentdeck.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatTimelineTest {
    private var clock = 0
    private fun event(
        kind: String,
        summary: String,
        detail: String? = null,
        tool: String? = null,
        path: String? = null,
    ) = AgentEvent(
        id = "e${clock}",
        kind = kind,
        summary = summary,
        detail = detail,
        tool = tool,
        path = path,
        createdAt = "2026-08-31T10:00:${(clock++).toString().padStart(2, "0".single())}Z",
    )

    @Test
    fun `words stay messages and the work between them becomes one cluster`() {
        val timeline = chatTimeline(
            listOf(
                event("user", "Message", detail = "Fix the flaky test"),
                event("thought", "Reasoning", detail = "Looking at the test first"),
                event("tool", "Edit", tool = "Edit", path = "a.ts"),
                event("tool", "Bash", tool = "Bash"),
                event("output", "Response", detail = "Done — the test is fixed."),
            ),
        )
        assertEquals(3, timeline.size)
        assertTrue(timeline[0] is TimelineItem.Message)
        val work = timeline[1] as TimelineItem.Activity
        assertEquals(listOf("Reasoning", "Edit", "Bash"), work.events.map { it.summary })
        val reply = timeline[2] as TimelineItem.Message
        assertEquals(ConversationRole.Agent, reply.entry.role)
    }

    @Test
    fun `two exchanges keep their work in separate clusters`() {
        val timeline = chatTimeline(
            listOf(
                event("user", "Message", detail = "First"),
                event("tool", "Bash", tool = "Bash"),
                event("output", "Response", detail = "First done."),
                event("user", "Message", detail = "Second"),
                event("tool", "Edit", tool = "Edit"),
                event("output", "Response", detail = "Second done."),
            ),
        )
        assertEquals(
            listOf("Message", "Activity", "Message", "Message", "Activity", "Message"),
            timeline.map { it::class.simpleName },
        )
    }

    @Test
    fun `plumbing never earns a row, and the instruction stays a message`() {
        val timeline = chatTimeline(
            listOf(
                // The adapters without a user event publish the instruction as
                // this thought; it is the person speaking, not activity.
                event("thought", "Received instruction", detail = "Fix the tests"),
                event("user", "Message", detail = "<task-notification>machinery</task-notification>"),
                event("tool", "Bash", tool = "Bash"),
            ),
        )
        assertEquals(2, timeline.size)
        val instruction = timeline[0] as TimelineItem.Message
        assertEquals(ConversationRole.User, instruction.entry.role)
        assertEquals(1, (timeline[1] as TimelineItem.Activity).events.size)
    }

    @Test
    fun `the collapsed line says what the work amounted to, the way a person would`() {
        val summary = activitySummary(
            listOf(
                event("tool", "Edit a.ts", tool = "Edit", path = "a.ts"),
                event("tool", "Edit b.ts", tool = "Edit", path = "b.ts"),
                event("tool", "Bash", tool = "Bash"),
                event("thought", "Reasoning", detail = "hm"),
            ),
        )
        assertEquals("Ran 1 command, edited 2 files", summary)
        assertEquals("Thought once", activitySummary(listOf(event("thought", "Reasoning", detail = "x"))))
        assertEquals(
            "Read 1 file",
            activitySummary(listOf(event("tool", "Read a.ts", tool = "Read", path = "a.ts"))),
        )
        assertEquals("1 step", activitySummary(listOf(event("warning", "Needs attention"))))
    }

    @Test
    fun `the cluster's diff adds up across its steps`() {
        val stat = diffStat(
            listOf(
                event("tool", "Edit", tool = "Edit", path = "a.ts").copy(diff = "+one\n+two\n-old"),
                event("tool", "Edit", tool = "Edit", path = "b.ts").copy(diff = "+++ b/b.ts\n+three"),
                event("tool", "Bash", tool = "Bash"),
            ),
        )
        assertEquals(DiffStat(added = 3, removed = 1), stat)
        assertEquals(null, diffStat(listOf(event("tool", "Bash", tool = "Bash"))))
    }
}

class CompletionIsActivityTest {
    @Test
    fun `a completion reporting itself done is work, not words`() {
        val timeline = chatTimeline(
            listOf(
                AgentEvent("u1", "user", "Message", detail = "Tidy the docs", createdAt = "2026-08-31T10:00:00Z"),
                AgentEvent("e1", "output", "Edit completed", detail = "docs/a.md · +18 −6", createdAt = "2026-08-31T10:00:01Z"),
                AgentEvent("e2", "output", "Edit completed", detail = "docs/b.md · +2 −2", createdAt = "2026-08-31T10:00:02Z"),
                AgentEvent("r1", "output", "Response", detail = "Docs tidied.", createdAt = "2026-08-31T10:00:03Z"),
            ),
        )
        assertEquals(
            listOf("Message", "Activity", "Message"),
            timeline.map { it::class.simpleName },
        )
        assertEquals(2, (timeline[1] as TimelineItem.Activity).events.size)
    }
}
