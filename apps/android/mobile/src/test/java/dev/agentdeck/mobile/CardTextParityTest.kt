package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.chatTitle
import dev.agentdeck.shared.usefulTask
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The golden fixture's `cardText` section, executed against the Kotlin
 * strings. Each Agent is decoded through the shipping wire decoder, so this
 * pins the decode as well as the derivation — and every case in the corpus
 * was a live divergence between the two apps before these functions moved
 * out of their UI files.
 */
class CardTextParityTest {
    private fun fixture(): File {
        var dir: File? = File(System.getProperty("user.dir")!!)
        while (dir != null) {
            val candidate = File(dir, "packages/bridge-client/fixtures/attention-parity.json")
            if (candidate.exists()) return candidate
            dir = dir.parentFile
        }
        error("attention-parity.json not found above ${System.getProperty("user.dir")}")
    }

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `every card-text case answers as the corpus says`() {
        val cases = json.parseToJsonElement(fixture().readText())
            .jsonObject["cardText"]!!.jsonObject["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (entry in cases.map { it.jsonObject }) {
            val name = entry["case"]!!.jsonPrimitive.contentOrNull
            val agent = json.decodeFromJsonElement(Agent.serializer(), entry["agent"]!!)
            entry["usefulTask"]?.jsonPrimitive?.contentOrNull?.let {
                assertEquals(name, it, usefulTask(agent))
            }
            entry["chatTitle"]?.jsonPrimitive?.contentOrNull?.let {
                assertEquals(name, it, chatTitle(agent))
            }
            if (entry.containsKey("latestReasoningPreview")) {
                assertEquals(
                    name,
                    entry["latestReasoningPreview"]!!.jsonPrimitive.contentOrNull,
                    latestReasoningPreview(agent),
                )
            }
        }
    }
}
