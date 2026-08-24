package dev.agentdeck.wear

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import dev.agentdeck.shared.SecureTokenStore

class WearCredentialListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != CREDENTIAL_PATH) return
        val token = event.data.toString(Charsets.UTF_8)
        if (token.isNotBlank()) SecureTokenStore(this).put(token)
    }

    override fun onDataChanged(events: DataEventBuffer) {
        events.filter { it.type == DataEvent.TYPE_CHANGED && it.dataItem.uri.path == SNAPSHOT_PATH }.forEach { event ->
            val data = DataMapItem.fromDataItem(event.dataItem).dataMap
            val payload = data.getString("snapshot") ?: return@forEach
            getSharedPreferences("relay_cache", MODE_PRIVATE).edit()
                .putString("snapshot", payload)
                .putLong("publishedAt", data.getLong("publishedAt"))
                .apply()
        }
    }

    private companion object {
        const val CREDENTIAL_PATH = "/agent-deck/device-token"
        const val SNAPSHOT_PATH = "/agent-deck/snapshot"
    }
}
