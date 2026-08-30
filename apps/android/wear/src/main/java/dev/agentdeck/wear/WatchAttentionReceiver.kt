package dev.agentdeck.wear

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.agentdeck.shared.BridgeClient
import dev.agentdeck.shared.SecureTokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Acts on a decision taken from the notification itself.
 *
 * The answer goes to the bridge from here rather than through the phone: the
 * wrist is often the only thing in range, and a decision that needs a phone to
 * relay it is a decision that fails exactly when it was most convenient to
 * make.
 */
class WatchAttentionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val agentId = intent.getStringExtra(EXTRA_AGENT_ID) ?: return
        val control = intent.getStringExtra(EXTRA_CONTROL)
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
        val answer = intent.getStringExtra(EXTRA_ANSWER)

        // Taken down immediately: the decision is made, and a notification that
        // lingers invites making it twice.
        context.getSystemService(NotificationManager::class.java)?.cancel(agentId.hashCode())

        val pending = goAsync()
        val addresses = BridgeAddress(context)
        val token = SecureTokenStore(context).get()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                for (candidate in addresses.candidates(BuildConfig.BRIDGE_URL)) {
                    val client = BridgeClient(candidate, token)
                    val sent = runCatching {
                        when {
                            control != null -> client.control(agentId, control)
                            requestId != null && answer != null ->
                                client.answerQuestion(agentId, requestId, "", answer)
                            else -> return@runCatching
                        }
                    }.isSuccess
                    if (sent) {
                        addresses.remember(candidate)
                        WatchNotifier.rearm(context, agentId)
                        break
                    }
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val EXTRA_AGENT_ID = "agent_id"
        const val EXTRA_CONTROL = "control"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_ANSWER = "answer"
        const val EXTRA_KEY = "attention_key"
    }
}
