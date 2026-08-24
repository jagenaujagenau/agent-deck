package dev.agentdeck.mobile

import android.content.Context
import com.google.android.gms.wearable.Wearable

object WearCredentialSync {
    const val PATH = "/agent-deck/device-token"

    fun send(context: Context, token: String) {
        if (token.isBlank()) return
        Wearable.getNodeClient(context).connectedNodes.addOnSuccessListener { nodes ->
            nodes.forEach { node ->
                Wearable.getMessageClient(context).sendMessage(node.id, PATH, token.toByteArray(Charsets.UTF_8))
            }
        }
    }
}
