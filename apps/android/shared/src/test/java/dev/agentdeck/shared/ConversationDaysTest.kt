package dev.agentdeck.shared

import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The golden fixture's `conversationDays` section, executed against the Kotlin
 * separator. The same corpus drives `ConversationDays.swift`: iOS drew no
 * separators at all until it was written against these answers, and a label
 * that differs by phone is the kind of thing nobody notices until the two are
 * held side by side.
 */
class ConversationDaysTest {
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
        Json.parseToJsonElement(fixture().readText()).jsonObject["conversationDays"]!!.jsonObject

    @Test
    fun `every day case answers as the corpus says`() {
        val today = LocalDate.parse(section["today"]!!.jsonPrimitive.contentOrNull!!)
        val cases = section["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (entry in cases.map { it.jsonObject }) {
            val text = { key: String -> entry[key]?.jsonPrimitive?.contentOrNull }
            val separator = ConversationDays.separatorBefore(
                previous = text("previous"),
                current = text("current")!!,
                today = today,
                zone = ZoneId.of(text("zone")!!),
            )
            assertEquals(text("case"), text("separator"), separator)
        }
    }
}
