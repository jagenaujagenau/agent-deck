package dev.agentdeck.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AttentionPolicy

/**
 * Buzzes the wrist when a session is waiting on a person.
 *
 * The watch posts these itself rather than receiving the phone's. Wear does
 * not bridge a notification to a watch that has an app of the same package
 * installed - it assumes that app will speak for itself - so ours was silently
 * dropped while the phone alerted. Posting here also means the wrist still
 * works when the phone is out of range, which a bridged notification never
 * would.
 */
internal object WatchNotifier {
    private const val CHANNEL = "agent_attention"
    private const val PREFERENCES = "watch_notifications"

    fun reconcile(context: Context, agents: List<Agent>) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Agents needing you", NotificationManager.IMPORTANCE_HIGH),
        )
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        for (agent in agents) {
            val decision = AttentionPolicy.decide(
                agent = agent,
                previousAt = preferences.getString("observed:${agent.id}", null),
                previousResolved = preferences.getBoolean("resolved:${agent.id}", false),
                previousKey = preferences.getString("notified:${agent.id}", null),
            )
            if (decision.action == AttentionPolicy.Action.Ignore &&
                decision.observedAt == preferences.getString("observed:${agent.id}", null)
            ) {
                continue
            }
            val editor = preferences.edit()
                .putString("observed:${agent.id}", decision.observedAt)
                .putBoolean("resolved:${agent.id}", decision.resolved)
            decision.approvalKey?.let { editor.putString("notified:${agent.id}", it) }
            // Written before posting, so two snapshots arriving together cannot
            // both decide to buzz for the same thing.
            if (!editor.commit()) continue
            when (decision.action) {
                AttentionPolicy.Action.Cancel -> manager.cancel(agent.id.hashCode())
                AttentionPolicy.Action.Notify ->
                    manager.notify(agent.id.hashCode(), build(context, agent, decision.approvalKey!!))
                AttentionPolicy.Action.Ignore -> Unit
            }
        }
    }

    private fun build(context: Context, agent: Agent, attentionKey: String): Notification {
        val approval = agent.pendingApproval
        val durable = agent.pendingQuestion
        val question = agent.events.maxByOrNull { it.createdAt }?.takeIf { it.kind == "question" }
        val questionText = durable?.question?.takeIf { it.isNotBlank() } ?: question?.detail ?: question?.summary
        val questionOptions = durable?.options.orEmpty().ifEmpty { question?.options.orEmpty() }
        val questionId = durable?.id ?: question?.id
        val detail = approval?.detail ?: questionText ?: agent.task

        val builder = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(
                if (approval != null) "${agentLabel(agent.name, agent.project)} needs approval"
                else "${agentLabel(agent.name, agent.project)} has a question",
            )
            .setContentText(detail)
            .setStyle(Notification.BigTextStyle().bigText(detail))
            .setContentIntent(openAgent(context, agent))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_RECOMMENDATION)

        if (approval != null) {
            builder.addAction(action(context, agent, "reject", "Reject", attentionKey, 1))
            builder.addAction(action(context, agent, "approve", "Approve", attentionKey, 2))
        } else if (questionId != null) {
            // Answering from the notification is the whole point on a wrist:
            // three taps deep into the app to press a button that could have
            // been on the buzz itself is the app failing at its one job.
            questionOptions.take(3).forEachIndexed { index, option ->
                builder.addAction(answer(context, agent, questionId, option, attentionKey, index + 3))
            }
        }
        return builder.build()
    }

    private fun openAgent(context: Context, agent: Agent) = PendingIntent.getActivity(
        context,
        agent.id.hashCode(),
        Intent(context, WearActivity::class.java)
            .putExtra(WearActivity.EXTRA_AGENT_ID, agent.id)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun action(
        context: Context,
        agent: Agent,
        control: String,
        label: String,
        attentionKey: String,
        offset: Int,
    ) = Notification.Action.Builder(
        null,
        label,
        PendingIntent.getBroadcast(
            context,
            agent.id.hashCode() + offset,
            Intent(context, WatchAttentionReceiver::class.java)
                .putExtra(WatchAttentionReceiver.EXTRA_AGENT_ID, agent.id)
                .putExtra(WatchAttentionReceiver.EXTRA_CONTROL, control)
                .putExtra(WatchAttentionReceiver.EXTRA_KEY, attentionKey),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
    ).build()

    private fun answer(
        context: Context,
        agent: Agent,
        requestId: String,
        option: String,
        attentionKey: String,
        offset: Int,
    ) = Notification.Action.Builder(
        null,
        option,
        PendingIntent.getBroadcast(
            context,
            agent.id.hashCode() + offset,
            Intent(context, WatchAttentionReceiver::class.java)
                .putExtra(WatchAttentionReceiver.EXTRA_AGENT_ID, agent.id)
                .putExtra(WatchAttentionReceiver.EXTRA_REQUEST_ID, requestId)
                .putExtra(WatchAttentionReceiver.EXTRA_ANSWER, option)
                .putExtra(WatchAttentionReceiver.EXTRA_KEY, attentionKey),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
    ).build()
}
