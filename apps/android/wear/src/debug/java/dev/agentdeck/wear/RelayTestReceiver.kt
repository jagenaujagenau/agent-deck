package dev.agentdeck.wear

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.Wearable
import org.json.JSONObject

class RelayTestReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "dev.agentdeck.DEBUG_RELAY_REFRESH") return
        val pending = goAsync()
        Wearable.getNodeClient(context).connectedNodes.addOnCompleteListener { nodeTask ->
            if (!nodeTask.isSuccessful) {
                pending.finish()
                return@addOnCompleteListener
            }
            val agentId = intent.getStringExtra("agentId")
            val path = if (agentId == null) "/agent-deck/refresh" else "/agent-deck/control"
            val payload = if (agentId == null) ByteArray(0) else JSONObject()
                .put("agentId", agentId)
                .put("action", intent.getStringExtra("control") ?: "pause")
                .toString()
                .toByteArray()
            val sends = nodeTask.result.map { node ->
                Wearable.getMessageClient(context).sendMessage(node.id, path, payload)
            }
            Tasks.whenAllComplete(sends).addOnCompleteListener { pending.finish() }
        }
    }
}
