package dev.agentdeck.shared

import android.content.Context
import kotlinx.serialization.json.Json

/**
 * The last summary, kept where a widget can read it without a network.
 *
 * A widget is drawn on the system's schedule, not the app's - often with the
 * app dead and the bridge unreachable. Whatever is drawn then has to come from
 * disk, so the summary is written whenever a snapshot arrives and read back
 * unconditionally.
 *
 * Plain SharedPreferences rather than DataStore: the read happens on the
 * widget's own thread while it is composing, and a blocking read of one small
 * string is what is wanted there.
 */
object DeckSummaryStore {
    private const val FILE = "deck-summary"
    private const val KEY = "summary"
    private val json = Json { ignoreUnknownKeys = true }

    fun read(context: Context): DeckSummary {
        val raw = context
            .getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .getString(KEY, null)
            ?: return DeckSummary()
        // A summary written by an older build is not worth crashing a widget
        // over; an empty one draws as "not connected" until the next write.
        return runCatching { json.decodeFromString<DeckSummary>(raw) }.getOrDefault(DeckSummary())
    }

    fun write(context: Context, summary: DeckSummary) {
        context
            .getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, json.encodeToString(summary))
            .apply()
    }

    /** True when the write actually changes what a widget would draw. */
    fun differs(previous: DeckSummary, next: DeckSummary): Boolean =
        previous.lines != next.lines ||
            previous.attention != next.attention ||
            previous.running != next.running ||
            previous.idle != next.idle ||
            previous.reachedBridge != next.reachedBridge
}
