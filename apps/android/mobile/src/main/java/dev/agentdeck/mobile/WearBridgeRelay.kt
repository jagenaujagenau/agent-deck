package dev.agentdeck.mobile

import android.content.Context
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import dev.agentdeck.shared.BridgeClient
import dev.agentdeck.shared.BridgeSnapshot
import dev.agentdeck.shared.SecureTokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.json.JSONObject

object WearBridgeRelay {
    const val SNAPSHOT_PATH = "/agent-deck/snapshot"
    const val CONTROL_PATH = "/agent-deck/control"
    const val REFRESH_PATH = "/agent-deck/refresh"
    const val ANSWER_PATH = "/agent-deck/answer"
    const val CONTROL_RESULT_PATH = "/agent-deck/control-result"
    private val json = Json { ignoreUnknownKeys = true }

    fun publish(context: Context, snapshot: BridgeSnapshot) {
        val visibleSnapshot = wearRelaySnapshot(context, snapshot)
        val request = PutDataMapRequest.create(SNAPSHOT_PATH).apply {
            dataMap.putString("snapshot", json.encodeToString(BridgeSnapshot.serializer(), visibleSnapshot))
            dataMap.putLong("publishedAt", System.currentTimeMillis())
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(context).putDataItem(request)
    }
}

class WearControlListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path !in setOf(WearBridgeRelay.CONTROL_PATH, WearBridgeRelay.REFRESH_PATH, WearBridgeRelay.ANSWER_PATH)) return
        runBlocking(Dispatchers.IO) {
            runCatching {
                val preferences = getSharedPreferences("bridge", 0)
                val client = BridgeClient(
                    preferences.getString("url", BuildConfig.BRIDGE_URL) ?: BuildConfig.BRIDGE_URL,
                    SecureTokenStore(this@WearControlListenerService).get(),
                )
                if (event.path == WearBridgeRelay.CONTROL_PATH) {
                    val payload = JSONObject(event.data.toString(Charsets.UTF_8))
                    val commandId = payload.getString("commandId")
                    runCatching {
                        client.control(
                            payload.getString("agentId"),
                            payload.getString("action"),
                            payload.optString("value").takeIf { it.isNotBlank() },
                            commandId,
                        )
                        var delivered = false
                        for (attempt in 0 until 20) {
                            val receipt = runCatching { client.commandReceipt(commandId) }.getOrNull()
                            if (receipt?.status == "delivered") {
                                delivered = true
                                break
                            }
                            delay(500)
                        }
                        if (!delivered) error("Runtime did not acknowledge the command")
                    }.onSuccess {
                        Wearable.getMessageClient(this@WearControlListenerService).sendMessage(
                            event.sourceNodeId,
                            WearBridgeRelay.CONTROL_RESULT_PATH,
                            JSONObject().put("commandId", commandId).put("status", "delivered").toString().toByteArray(),
                        )
                    }.onFailure { error ->
                        Wearable.getMessageClient(this@WearControlListenerService).sendMessage(
                            event.sourceNodeId,
                            WearBridgeRelay.CONTROL_RESULT_PATH,
                            JSONObject().put("commandId", commandId).put("status", "failed").put("error", error.message ?: "Delivery failed").toString().toByteArray(),
                        )
                        throw error
                    }
                }
                if (event.path == WearBridgeRelay.ANSWER_PATH) {
                    val payload = JSONObject(event.data.toString(Charsets.UTF_8))
                    val commandId = payload.getString("commandId")
                    // Answering is a single synchronous resolve — unlike a command, there is no
                    // receipt to poll, so the POST returning is the delivery confirmation.
                    runCatching {
                        client.answerQuestion(
                            payload.getString("agentId"),
                            payload.getString("requestId"),
                            payload.getString("question"),
                            payload.getString("answer"),
                        )
                    }.onSuccess {
                        Wearable.getMessageClient(this@WearControlListenerService).sendMessage(
                            event.sourceNodeId,
                            WearBridgeRelay.CONTROL_RESULT_PATH,
                            JSONObject().put("commandId", commandId).put("status", "delivered").toString().toByteArray(),
                        )
                    }.onFailure { error ->
                        Wearable.getMessageClient(this@WearControlListenerService).sendMessage(
                            event.sourceNodeId,
                            WearBridgeRelay.CONTROL_RESULT_PATH,
                            JSONObject().put("commandId", commandId).put("status", "failed").put("error", error.message ?: "Answer failed").toString().toByteArray(),
                        )
                        throw error
                    }
                }
                client.snapshot()
            }.onSuccess { snapshot ->
                WearBridgeRelay.publish(this@WearControlListenerService, snapshot)
            }
        }
    }
}
