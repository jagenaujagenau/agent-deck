package dev.agentdeck.shared

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
 * The golden fixture's `openRequest` section, executed against the Kotlin
 * derivation. The same corpus drives `OpenRequest.swift`, because "is this
 * session asking me something" is one question — and it had five answers
 * before this seam existed.
 */
class OpenRequestParityTest {
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
        Json.parseToJsonElement(fixture().readText()).jsonObject["openRequest"]!!.jsonObject

    @Test
    fun `every open-request case answers as the corpus says`() {
        val now = Instant.parse(section["now"]!!.jsonPrimitive.contentOrNull!!)
        val cases = section["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (entry in cases.map { it.jsonObject }) {
            val text = { key: String -> entry[key]?.jsonPrimitive?.contentOrNull }
            val bool = { key: String -> entry[key]?.jsonPrimitive?.booleanOrNull ?: false }
            val agent = Agent(
                id = "a1",
                name = "Fixture",
                project = "parity",
                model = "test",
                state = entry["state"]!!.jsonPrimitive.contentOrNull!!,
                task = "",
                tokens = 0,
                costUsd = 0.0,
                lastSeenAt = "2026-08-31T11:55:00Z",
                events = entry["events"]?.jsonArray.orEmpty().map { raw ->
                    val fields = raw.jsonObject
                    AgentEvent(
                        id = fields["id"]!!.jsonPrimitive.contentOrNull!!,
                        kind = fields["kind"]!!.jsonPrimitive.contentOrNull!!,
                        summary = fields["summary"]!!.jsonPrimitive.contentOrNull!!,
                        createdAt = fields["createdAt"]!!.jsonPrimitive.contentOrNull!!,
                    )
                },
                pendingApproval = if (bool("approval")) {
                    PendingApproval(
                        "r1", "Bash", "run", "2026-08-31T11:55:00Z",
                        text("approvalExpiresAt") ?: "2026-08-31T12:10:00Z",
                    )
                } else {
                    null
                },
                pendingQuestion = if (bool("question")) {
                    PendingQuestion(
                        "r2", "Which?", listOf("A"), "2026-08-31T11:55:00Z",
                        text("questionExpiresAt") ?: "2026-08-31T12:10:00Z",
                    )
                } else {
                    null
                },
            )
            val answer = when (openRequest(agent, now)) {
                is OpenRequest.Approval -> "approval"
                is OpenRequest.Question -> "question"
                null -> "none"
            }
            assertEquals(entry["case"]!!.jsonPrimitive.contentOrNull, text("expect"), answer)
        }
    }
}
