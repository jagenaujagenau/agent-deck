package dev.agentdeck.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.agentdeck.shared.Agent
import java.time.Instant
import dev.agentdeck.shared.supportsCapability

/** Posts each concrete approval event once, durably across reconnects and process restarts. */
internal object ApprovalNotifier {
    private const val CHANNEL = "agent_approvals"
    private const val PREFERENCES = "approval_notifications"

    internal enum class Action { Ignore, Cancel, Notify }
    internal data class Decision(val action: Action, val observedAt: String, val resolved: Boolean, val approvalKey: String?)

    internal fun approvalKey(agent: Agent): String? {
        val approval = agent.pendingApproval ?: return null
        if (!supportsCapability(agent.capabilities, "approve") || !supportsCapability(agent.capabilities, "reject")) return null
        if (agent.state != "waiting" || runCatching { Instant.parse(approval.expiresAt).isAfter(Instant.now()) }.getOrDefault(false).not()) return null
        return "${agent.id}:${approval.id}"
    }

    private fun attentionKey(agent: Agent): String? {
        approvalKey(agent)?.let { return it }
        if (agent.state != "waiting") return null
        return agent.events.maxByOrNull { it.createdAt }?.takeIf { it.kind == "question" }?.let { "${agent.id}:${it.id}" }
    }

    internal fun decide(agent: Agent, previousAt: String?, previousResolved: Boolean, previousKey: String?): Decision {
        val observedAt = maxOf(agent.lastSeenAt, agent.events.maxOfOrNull { it.createdAt } ?: agent.lastSeenAt)
        val key = attentionKey(agent)
        if (previousAt != null && observedAt < previousAt) return Decision(Action.Ignore, previousAt, previousResolved, previousKey)
        if (previousAt == observedAt && previousResolved && key != null) {
            return Decision(Action.Ignore, previousAt, previousResolved, previousKey)
        }
        return Decision(
            action = when {
                key == null && !previousResolved -> Action.Cancel
                key == null -> Action.Ignore
                key == previousKey -> Action.Ignore
                else -> Action.Notify
            },
            observedAt = observedAt,
            resolved = key == null,
            approvalKey = key,
        )
    }

    @Synchronized
    fun reconcile(context: Context, agents: List<Agent>) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Agent approvals", NotificationManager.IMPORTANCE_HIGH),
        )
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
            val decision = decide(
                agent = agent,
                previousAt = preferences.getString(observedKey, null),
                previousResolved = preferences.getBoolean(resolvedKey, false),
                previousKey = preferences.getString(notifiedKey, null) ?: preferences.getString(agent.id, null),
            )
            if (decision.action == Action.Ignore && decision.observedAt == preferences.getString(observedKey, null)) continue
            val editor = preferences.edit()
                .putString(observedKey, decision.observedAt)
                .putBoolean(resolvedKey, decision.resolved)
            decision.approvalKey?.let { editor.putString(notifiedKey, it) }
            // Commit before posting so concurrent service/worker snapshots cannot both alert.
            if (!editor.commit()) continue
            when (decision.action) {
                Action.Cancel -> manager.cancel(agent.id.hashCode())
                Action.Notify -> manager.notify(agent.id.hashCode(), notification(context, agent, decision.approvalKey!!))
                Action.Ignore -> Unit
            }
        }
    }

    private fun notification(context: Context, agent: Agent, approvalKey: String): Notification {
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
        val detail = approval?.detail ?: question?.detail ?: agent.task
        val builder = Notification.Builder(context, CHANNEL)
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
