package dev.agentdeck.wear

import android.content.Context

/**
 * Which address the watch should use to reach the bridge.
 *
 * The phone and the watch do not necessarily share a route to it. A phone on a
 * tailnet reaches it by a name the watch cannot resolve, and a watch told that
 * name simply stops working - which is what happened: every session reported
 * the bridge unreachable while the bridge was fine.
 *
 * So an address is a candidate rather than an instruction. The one that
 * answered last is tried first, the alternatives after it, and whatever works
 * is remembered.
 */
internal class BridgeAddress(private val context: Context) {
    private val preferences get() = context.getSharedPreferences("bridge", Context.MODE_PRIVATE)

    /** Every address worth trying, best guess first. */
    fun candidates(fallback: String): List<String> {
        val working = preferences.getString(WORKING, null)
        val synced = preferences.getString("url", null)
        return listOfNotNull(working, synced, fallback)
            .map { it.trimEnd('/') }
            .filter { it.isNotBlank() }
            .distinct()
    }

    /** Records the address that answered, so the next fetch starts there. */
    fun remember(url: String) {
        preferences.edit().putString(WORKING, url.trimEnd('/')).apply()
    }

    private companion object {
        const val WORKING = "working_url"
    }
}
