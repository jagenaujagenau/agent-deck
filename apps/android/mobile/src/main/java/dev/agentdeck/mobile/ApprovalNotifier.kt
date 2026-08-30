package dev.agentdeck.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AlertArming
import dev.agentdeck.shared.AttentionPolicy
import dev.agentdeck.shared.AttentionPolicy.Action
import dev.agentdeck.shared.SeenStore
import dev.agentdeck.shared.supportsCapability

/** Posts each concrete approval event once, durably across reconnects and process restarts. */
internal object ApprovalNotifier {
    private const val CHANNEL = "agent_approvals"
    // Repeats while the first ask sits unviewed land here: present in the
    // shade with the newest request, but silent — see AlertArming.
    private const val QUIET_CHANNEL = "agent_approvals_quiet"
    private const val PREFERENCES = "approval_notifications"


    @Synchronized
    fun reconcile(context: Context, agents: List<Agent>) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Agent approvals", NotificationManager.IMPORTANCE_HIGH),
        )
        manager.createNotificationChannel(
            NotificationChannel(QUIET_CHANNEL, "Agent approvals (repeats)", NotificationManager.IMPORTANCE_LOW),
        )
        val seenStore = SeenStore(context)
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val archived = normalizeArchivedAgentKeys(context.getSharedPreferences("bridge", Context.MODE_PRIVATE).getStringSet("archived_agents", emptySet())?.toSet() ?: emptySet())
        for (agent in agents) {
            if (agentArchiveKey(agent) in archived) {
                manager.cancel(agent.id.hashCode())
                continue
            }
            val observedKey = "observed:${agent.id}"
            val resolvedKey = "resolved:${agent.id}"
            val notifiedKey = "notified:${agent.id}"
            val decision = AttentionPolicy.decide(
                agent = agent,
                previousAt = preferences.getString(observedKey, null),
                previousResolved = preferences.getBoolean(resolvedKey, false),
                previousKey = preferences.getString(notifiedKey, null) ?: preferences.getString(agent.id, null),
            )
            if (decision.action == Action.Ignore && decision.observedAt == preferences.getString(observedKey, null)) continue
            val alertedKey = "alerted:${agent.id}"
            val armed = decision.action == Action.Notify &&
                AlertArming.armed(agent, seenStore.seenAt(agent.id), preferences.getString(alertedKey, null))
            val editor = preferences.edit()
                .putString(observedKey, decision.observedAt)
                .putBoolean(resolvedKey, decision.resolved)
            decision.approvalKey?.let { editor.putString(notifiedKey, it) }
            if (armed) editor.putString(alertedKey, decision.observedAt)
            // Commit before posting so concurrent service/worker snapshots cannot both alert.
            if (!editor.commit()) continue
            when (decision.action) {
                Action.Cancel -> manager.cancel(agent.id.hashCode())
                Action.Notify -> manager.notify(
                    agent.id.hashCode(),
                    notification(context, agent, decision.approvalKey!!, if (armed) CHANNEL else QUIET_CHANNEL),
                )
                Action.Ignore -> Unit
            }
        }
    }

    /** An answer from the shade is engagement, not a view — but it re-arms all the same. */
    fun rearm(context: Context, agentId: String) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit().remove("alerted:$agentId").apply()
    }

    private fun notification(context: Context, agent: Agent, approvalKey: String, channel: String): Notification {
        fun actionIntent(action: String, offset: Int) = PendingIntent.getBroadcast(
            context,
            agent.id.hashCode() + offset,
            Intent(context, ApprovalReceiver::class.java)
                .putExtra(ApprovalReceiver.EXTRA_AGENT_ID, agent.id)
                .putExtra(ApprovalReceiver.EXTRA_ACTION, action)
                .putExtra(ApprovalReceiver.EXTRA_APPROVAL_KEY, approvalKey),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openIntent = PendingIntent.getActivity(
            context,
            agent.id.hashCode(),
            Intent(Intent.ACTION_VIEW, Uri.parse("agentdeck://agent/${Uri.encode(agent.id)}"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val approval = agent.pendingApproval
        val question = agent.events.maxByOrNull { it.createdAt }?.takeIf { it.kind == "question" }
        val detail = approval?.detail ?: agent.pendingQuestion?.question ?: question?.detail ?: agent.task
        val builder = Notification.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(if (approval != null) "${agent.name} needs approval" else "${agent.name} has a question")
            .setContentText(detail)
            .setStyle(Notification.BigTextStyle().bigText(detail))
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_RECOMMENDATION)
        if (approval != null) {
            builder.addAction(Notification.Action.Builder(null, "Reject", actionIntent("reject", 1)).build())
            builder.addAction(Notification.Action.Builder(null, "Approve", actionIntent("approve", 2)).build())
        }
        return builder.build()
    }
}
