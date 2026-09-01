package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.PendingApproval
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test
import dev.agentdeck.shared.agentCardActivity

class AgentCardPolicyTest {
    private fun agent(
        state: String = "running",
        task: String = "Fix the card",
        objective: String? = "Fix the card",
        events: List<AgentEvent> = emptyList(),
        approval: PendingApproval? = null,
        capabilities: List<String>? = null,
    ) = Agent(
        id = "agent-1", name = "Pi", project = "deck", model = "openai/gpt-5",
        state = state, task = task, objective = objective, tokens = 12_000, costUsd = 0.0,
        lastSeenAt = "2026-08-24T10:00:00Z", events = events, pendingApproval = approval, capabilities = capabilities,
    )

    @Test
    fun activityPrioritizesWhatTheAgentIsDoingNow() {
        // A clock at the fixture's own heartbeat: signal is flowing.
        val now = Instant.parse("2026-08-24T10:00:30Z").toEpochMilli()
        assertEquals("Working on instruction", agentCardActivity(agent(), now))
        assertEquals("Using bash", agentCardActivity(agent(task = "Using bash"), now))
        assertEquals("bash finished", agentCardActivity(agent(task = "bash completed"), now))
    }

    @Test
    fun attentionActivityExplainsTheRequiredHumanAction() {
        val question = AgentEvent("q", "question", "Choose", "Which option?", "2026-08-24T10:00:00Z")
        assertEquals("Awaiting your answer", agentCardActivity(agent(state = "waiting", events = listOf(question))))
        // A live approval: `openRequest` refuses an expired one, and an ask
        // nobody can answer any more is not what the card should name.
        val approval = PendingApproval(
            "a", "bash", "Run command", "2026-08-24T10:00:00Z",
            Instant.now().plusSeconds(600).toString(),
        )
        assertEquals("Review required", agentCardActivity(agent(state = "waiting", approval = approval)))
        assertEquals("Input required in host runtime", agentCardActivity(agent(state = "waiting")))
        assertEquals("Open session to continue", agentCardActivity(agent(state = "waiting", capabilities = listOf("steer"))))
    }

    @Test
    fun freshnessIsExplicit() {
        val now = Instant.parse("2026-08-24T10:05:00Z")
        assertEquals("5m ago", cardFreshness("2026-08-24T10:00:00Z", now))
        assertEquals("now", cardFreshness("2026-08-24T10:04:40Z", now))
    }

    @Test
    fun modelVersionsRemainReadableAndPrecise() {
        assertEquals("Opus 4.8", humanizeModelId("opus-4-8"))
        assertEquals("5.6 Sol", humanizeModelId("5-6-sol"))
    }

    @Test
    fun cardShowsOnlyACompactPlainTextReasoningPreviewWhileThinking() {
        val instruction = AgentEvent("i", "thought", "Received instruction", "Do the work", "2026-08-24T10:00:00Z")
        val reasoning = AgentEvent("r", "thought", "Reasoning", "**Compare** the `current behavior` carefully before applying the smallest safe correction.", "2026-08-24T10:00:01Z")
        val value = latestReasoningPreview(agent(events = listOf(instruction, reasoning)), limit = 42)
        assertEquals("Compare the current behavior carefully…", value)

        // Hook runtimes always land a tool result after the thought that led to it; the card must
        // still show what the agent is currently thinking, exactly as it does for streamed reasoning.
        val tool = AgentEvent("t", "tool", "Using bash", null, "2026-08-24T10:00:02Z")
        assertEquals(
            "Compare the current behavior carefully before applying the smallest safe correction.",
            latestReasoningPreview(agent(events = listOf(reasoning, tool))),
        )

        // Transcript-recovered reasoning lags a tool call behind, so age must not disqualify it.
        val muchLaterTool = AgentEvent("t2", "tool", "Using bash", null, "2026-08-24T10:30:00Z")
        assertEquals(
            "Compare the current behavior carefully before applying the smallest safe correction.",
            latestReasoningPreview(agent(events = listOf(reasoning, muchLaterTool))),
        )

        // An agent that is not running shows its outcome, not a train of thought.
        assertEquals(null, latestReasoningPreview(agent(state = "paused", events = listOf(reasoning))))
    }
}
