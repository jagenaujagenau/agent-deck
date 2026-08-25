package dev.agentdeck.mobile

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.agentdeck.shared.BridgeClient
import dev.agentdeck.shared.SecureTokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import dev.agentdeck.shared.AttentionPolicy

class ApprovalReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val agentId = intent.getStringExtra(EXTRA_AGENT_ID) ?: return
        val action = intent.getStringExtra(EXTRA_ACTION)?.takeIf { it == "approve" || it == "reject" } ?: return
        val approvalKey = intent.getStringExtra(EXTRA_APPROVAL_KEY) ?: return
        val pendingResult = goAsync()
        val appContext = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val preferences = appContext.getSharedPreferences("bridge", 0)
                val client = BridgeClient(
                    preferences.getString("url", BuildConfig.BRIDGE_URL) ?: BuildConfig.BRIDGE_URL,
                    SecureTokenStore(appContext).get(),
                )
                val current = client.snapshot().agents.firstOrNull { it.id == agentId }
                if (current != null && AttentionPolicy.approvalKey(current) == approvalKey) {
                    client.control(agentId, action)
                }
                appContext.getSystemService(NotificationManager::class.java).cancel(agentId.hashCode())
            } finally {
                pendingResult.finish()
            }
        }
    }

    companion object {
        const val EXTRA_AGENT_ID = "agent_id"
        const val EXTRA_ACTION = "action"
        const val EXTRA_APPROVAL_KEY = "approval_key"
    }
}
