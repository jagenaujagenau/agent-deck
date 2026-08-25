package dev.agentdeck.wear

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import dev.agentdeck.shared.BridgeSnapshot
import dev.agentdeck.shared.SecureTokenStore
import kotlinx.serialization.json.Json
import org.json.JSONObject

class WearCredentialListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != CREDENTIAL_PATH) return
        val body = event.data.toString(Charsets.UTF_8)
        if (body.isBlank()) return
        // Older phones sent the bare token; newer ones send it with the address
        // the watch should use. Accept both so a stale phone build still pairs.
        val payload = runCatching { JSONObject(body) }.getOrNull()
        val token = payload?.optString("token")?.takeIf { it.isNotBlank() } ?: body
        SecureTokenStore(this).put(token)
        payload?.optString("url")?.takeIf { it.isNotBlank() }?.let { url ->
            getSharedPreferences("bridge", MODE_PRIVATE).edit().putString("url", url).apply()
        }
    }

    override fun onDataChanged(events: DataEventBuffer) {
        events.filter { it.type == DataEvent.TYPE_CHANGED && it.dataItem.uri.path == SNAPSHOT_PATH }.forEach { event ->
            val data = DataMapItem.fromDataItem(event.dataItem).dataMap
            val payload = data.getString("snapshot") ?: return@forEach
            getSharedPreferences("relay_cache", MODE_PRIVATE).edit()
                .putString("snapshot", payload)
                .putLong("publishedAt", data.getLong("publishedAt"))
                .apply()
            // This service runs whether or not the app is open, which is what
            // makes it the right place to decide the wrist should buzz.
            runCatching {
                val snapshot = Json { ignoreUnknownKeys = true }
                    .decodeFromString(BridgeSnapshot.serializer(), payload)
                WatchNotifier.reconcile(this, snapshot.agents)
            }
        }
    }

    private companion object {
        const val CREDENTIAL_PATH = "/agent-deck/device-token"
        const val SNAPSHOT_PATH = "/agent-deck/snapshot"
    }
}
