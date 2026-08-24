package dev.agentdeck.mobile

import dev.agentdeck.shared.AgentEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentConversationTest {
    private fun event(id: String, kind: String, summary: String, detail: String? = null, second: Int = 0, command: String? = null) =
        AgentEvent(id, kind, summary, detail, "2026-08-24T10:00:${second.toString().padStart(2, '0')}Z", command = command)

    @Test
    fun chatContainsOnlyUserMessagesAndAgentResponsesInChronologicalOrder() {
        val entries = conversationEntries(listOf(
            event("tool", "output", "bash completed", null, 2),
            event("pause", "output", "Remote command: pause", null, 2),
            event("answer", "output", "Response", "Done **successfully**", 3),
            event("prompt", "thought", "Received instruction", "Fix the test", 1),
        ))

        assertEquals(listOf(ConversationRole.User, ConversationRole.Agent), entries.map { it.role })
        assertEquals(listOf("Fix the test", "Done **successfully**"), entries.map { it.content })
    }

    @Test
    fun duplicateRuntimeEchoOfRemoteMessageIsCollapsed() {
        val entries = conversationEntries(listOf(
            event("queued", "user", "Remote command: steer", "Use SQLite", 1),
            event("runtime", "output", "Remote command: steer", "Use SQLite", 2),
        ))

        assertEquals(1, entries.size)
        assertEquals(ConversationRole.User, entries.single().role)
    }

    @Test
    fun terminalKeepsOnlyCommands() {
        val events = listOf(
            event("command", "tool", "Bash", command = "pwd"),
            event("response", "output", "Response", "Finished"),
            event("error", "error", "Failed"),
        )
        assertEquals(listOf("command"), terminalEvents(events).map { it.id })
    }

    @Test
    fun reasoningKeepsOnlyProviderExposedThoughts() {
        val events = listOf(
            event("prompt", "thought", "Received instruction", "Fix scrolling"),
            event("reasoning", "thought", "Reasoning", "I should preserve user scroll ownership.", 1),
            event("response", "output", "Response", "Done", 2),
            event("empty", "thought", "Reasoning", null, 3),
        )
        assertEquals(listOf("reasoning"), reasoningEvents(events).map { it.id })
    }

    @Test
    fun terminalCommandUsesRealMessagingCapabilityAndPreservesExactCommand() {
        assertEquals(false, supportsCapability(null, "prompt"))
        assertEquals(true, supportsCapability(listOf("prompt"), "prompt"))
        assertEquals("steer", remoteMessageAction("running") { it == "steer" })
        assertEquals("prompt", remoteMessageAction("idle") { it == "prompt" })
        assertEquals(null, remoteMessageAction("idle") { false })
        assertEquals(
            "Run this exact shell command using the runtime's shell tool. Do not alter it:\n\n```sh\nprintf 'hello'\n```",
            terminalCommandInstruction("  printf 'hello'  "),
        )
    }

    @Test
    fun terminalCommandFenceCannotBeBrokenByCommandContent() {
        assertEquals(
            "Run this exact shell command using the runtime's shell tool. Do not alter it:\n\n````sh\nprintf '```'\n````",
            terminalCommandInstruction("printf '```'"),
        )
    }

    @Test
    fun repairsHistoricalFlattenedMarkdownTableRows() {
        val flattened = "Implemented. | Before | After | |---|---| | Old | New | Complete."
        assertEquals(
            "Implemented.\n\n| Before | After |\n|---|---|\n| Old | New |\n\nComplete.",
            restoreFlattenedMarkdown(flattened),
        )
        assertEquals(
            listOf(
                ResponseBlock.Markdown("Implemented."),
                ResponseBlock.Table(listOf("Before", "After"), listOf(listOf("Old", "New"))),
                ResponseBlock.Markdown("Complete."),
            ),
            responseBlocks(flattened),
        )
    }

    @Test
    fun repairsMultipleFlattenedMarkdownTablesWithoutAbsorbingLaterHeadings() {
        val flattened = "Implemented. ### Chat | Before | After | |---|---| | Jumped | Stable | ### Terminal | Before | After | |---|---| | Feed | Commands | ### Reasoning | Before | After | |---|---| | Mixed | Separate | Complete."
        assertEquals(
            listOf(
                ResponseBlock.Markdown("Implemented.\n\n### Chat"),
                ResponseBlock.Table(listOf("Before", "After"), listOf(listOf("Jumped", "Stable"))),
                ResponseBlock.Markdown("### Terminal"),
                ResponseBlock.Table(listOf("Before", "After"), listOf(listOf("Feed", "Commands"))),
                ResponseBlock.Markdown("### Reasoning"),
                ResponseBlock.Table(listOf("Before", "After"), listOf(listOf("Mixed", "Separate"))),
                ResponseBlock.Markdown("Complete."),
            ),
            responseBlocks(flattened),
        )
    }
}
