package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.PendingApproval
import dev.agentdeck.shared.PendingQuestion
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The golden fixture's homeState section, executed against the Kotlin
 * implementation. The same corpus drives HomePolicy.swift (swift test in
 * apps/ios/PolicyTests), so the two home decks answering differently is a
 * failing build instead of a drifting comment.
 */
class HomeStateParityTest {
    private fun fixture(): File {
        var dir: File? = File(System.getProperty("user.dir")!!)
        while (dir != null) {
            val candidate = File(dir, "packages/bridge-client/fixtures/attention-parity.json")
            if (candidate.exists()) return candidate
            dir = dir.parentFile
        }
        error("attention-parity.json not found above ${System.getProperty("user.dir")}")
    }

    private val section =
        Json.parseToJsonElement(fixture().readText()).jsonObject["homeState"]!!.jsonObject

    private val names = mapOf(
        "failed" to HomeAgentState.Failed,
        "approval-required" to HomeAgentState.ApprovalRequired,
        "question" to HomeAgentState.Question,
        "input-required" to HomeAgentState.InputRequired,
        "done" to HomeAgentState.Done,
        "running" to HomeAgentState.Running,
        "paused" to HomeAgentState.Paused,
        "recently-completed" to HomeAgentState.RecentlyCompleted,
        "history" to HomeAgentState.History,
    )

    @Test
    fun `the section order is the corpus's, which is the attention ranking`() {
        assertEquals(
            section["sectionOrder"]!!.jsonArray.map { names[it.jsonPrimitive.contentOrNull]!! },
            HomeAgentState.entries.toList(),
        )
    }

    @Test
    fun `amber is reserved for exactly the corpus's attention states`() {
        val attention =
            section["attentionStates"]!!.jsonArray.map { names[it.jsonPrimitive.contentOrNull]!! }
        for (state in HomeAgentState.entries) {
            assertEquals(state.name, state in attention, state.attention)
        }
    }

    @Test
    fun `every presentation case answers as the corpus says`() {
        val now = Instant.parse(section["now"]!!.jsonPrimitive.contentOrNull!!)
        val cases = section["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (entry in cases.map { it.jsonObject }) {
            val bool = { key: String -> entry[key]!!.jsonPrimitive.booleanOrNull!! }
            val agent = Agent(
                id = "a1",
                name = "Fixture",
                project = "parity",
                model = "test",
                state = entry["state"]!!.jsonPrimitive.contentOrNull!!,
                task = "",
                tokens = 0,
                costUsd = 0.0,
                lastSeenAt = entry["lastSeenAt"]!!.jsonPrimitive.contentOrNull!!,
                events = if (bool("questionEvent")) {
                    listOf(AgentEvent("q1", "question", "Choose", createdAt = "2026-08-30T11:55:00Z"))
                } else {
                    emptyList()
                },
                pendingApproval = if (bool("approval")) {
                    PendingApproval("r1", "Bash", "run", "2026-08-30T11:55:00Z", "2026-08-30T12:10:00Z")
                } else {
                    null
                },
                pendingQuestion = if (bool("question")) {
                    PendingQuestion("r2", "Which?", listOf("A"), "2026-08-30T11:55:00Z", "2026-08-30T12:10:00Z")
                } else {
                    null
                },
            )
            assertEquals(
                entry["case"]!!.jsonPrimitive.contentOrNull,
                names[entry["expect"]!!.jsonPrimitive.contentOrNull]!!,
                homeAgentState(agent, archived = bool("archived"), now = now, seen = bool("seen")),
            )
        }
    }
}
