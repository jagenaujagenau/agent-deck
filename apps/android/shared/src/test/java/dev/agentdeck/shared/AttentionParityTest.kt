package dev.agentdeck.shared

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The golden fixture, executed against the Kotlin implementation.
 *
 * The same corpus drives attention.ts (bun test) and AttentionPolicy.swift +
 * SeenPolicy.swift (swift test), so three languages answering differently is a
 * failing build instead of a drifting comment.
 */
class AttentionParityTest {
    private fun fixture(): File {
        var dir: File? = File(System.getProperty("user.dir")!!)
        while (dir != null) {
            val candidate = File(dir, "packages/bridge-client/fixtures/attention-parity.json")
            if (candidate.exists()) return candidate
            dir = dir.parentFile
        }
        error("attention-parity.json not found above ${System.getProperty("user.dir")}")
    }

    private val corpus = Json.parseToJsonElement(fixture().readText()).jsonObject

    @Test
    fun `every rank case answers as the corpus says`() {
        val cases = corpus["rank"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (entry in cases.map { it.jsonObject }) {
            assertEquals(
                entry["case"]!!.jsonPrimitive.contentOrNull,
                entry["expect"]!!.jsonPrimitive.int,
                attentionPriority(
                    state = entry["state"]!!.jsonPrimitive.contentOrNull!!,
                    blocked = entry["blocked"]!!.jsonPrimitive.booleanOrNull!!,
                    seen = entry["seen"]!!.jsonPrimitive.booleanOrNull!!,
                ),
            )
        }
    }

    @Test
    fun `every seen case answers as the corpus says`() {
        val cases = corpus["seen"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (entry in cases.map { it.jsonObject }) {
            val agent = Agent(
                id = "a1",
                name = "Fixture",
                project = "parity",
                model = "test",
                state = "idle",
                task = "",
                tokens = 0,
                costUsd = 0.0,
                lastSeenAt = entry["lastSeenAt"]!!.jsonPrimitive.contentOrNull!!,
                viewedAt = entry["viewedAt"]!!.jsonPrimitive.contentOrNull,
                events = entry["eventAts"]!!.jsonArray.mapIndexed { index, at ->
                    AgentEvent(
                        id = "e$index",
                        kind = "output",
                        summary = "",
                        createdAt = at.jsonPrimitive.contentOrNull!!,
                    )
                },
            )
            assertEquals(
                entry["case"]!!.jsonPrimitive.contentOrNull,
                entry["expect"]!!.jsonPrimitive.booleanOrNull!!,
                sessionSeen(agent, entry["localSeenAt"]!!.jsonPrimitive.contentOrNull),
            )
        }
    }
}
