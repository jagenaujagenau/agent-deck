package dev.agentdeck.mobile

import android.content.Context
import com.google.android.gms.wearable.Wearable
import org.json.JSONObject

/**
 * Hands the watch what it needs to reach the bridge on its own.
 *
 * The token alone is not enough. A watch that knows the credential but not the
 * address has nothing to use it on, and its own stored address is whatever it
 * was told once - loopback, in the case that prompted this, which is a host
 * that exists on the watch and answers nothing. The address travels with the
 * credential now, because it changes with the network while the credential
 * does not.
 */
object WearCredentialSync {
    const val PATH = "/agent-deck/device-token"

    fun send(context: Context, token: String) {
        if (token.isBlank()) return
        val url = context.getSharedPreferences("bridge", Context.MODE_PRIVATE)
            .getString("url", BuildConfig.BRIDGE_URL) ?: BuildConfig.BRIDGE_URL
        val payload = JSONObject().put("token", token).put("url", url).toString()
        Wearable.getNodeClient(context).connectedNodes.addOnSuccessListener { nodes ->
            nodes.forEach { node ->
                Wearable.getMessageClient(context)
                    .sendMessage(node.id, PATH, payload.toByteArray(Charsets.UTF_8))
            }
        }
    }
}
