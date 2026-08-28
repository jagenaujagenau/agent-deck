package dev.agentdeck.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.SeenStore
import dev.agentdeck.shared.sessionSeen
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Which session this phone is showing right now, if any.
 *
 * A "finished" buzz for the session already filling the screen tells the
 * person what they are watching happen. The monitor service runs in the app's
 * own process, so a plain object is enough for the two to agree.
 */
internal object ForegroundSession {
    @Volatile var openAgentId: String? = null
    @Volatile var foreground: Boolean = false

    fun showing(agentId: String): Boolean = foreground && openAgentId == agentId
}

/**
 * When a session's state change deserves a "finished" notification, decided purely.
 *
 * The deck notifies on exactly two transitions: into blocked, which the
 * approval/question flow already covers instantly, and into genuine
 * completion, which is this. The asymmetry is deliberate - into working or
 * blocked is instant everywhere, into "done" needs proof - because runtimes
 * flick through idle between tool calls, and a buzz for every flicker teaches
 * the person to ignore the buzz.
 */
internal object CompletionPolicy {
    /** How long running→idle must hold before it counts as finished. */
    const val DEBOUNCE_MS = 1_000L

    enum class Transition { StartDebounce, CancelDebounce, None }

    /**
     * Only an *observed* running→idle opens the window; a session first seen
     * idle proves nothing about when it finished. Any move off idle closes it -
     * back to running is the flicker being debounced away, and into waiting or
     * error is a louder story another notifier already tells.
     */
    fun transition(previous: String?, current: String): Transition = when {
        previous == "running" && current == "idle" -> Transition.StartDebounce
        current != "idle" -> Transition.CancelDebounce
        else -> Transition.None
    }

    /** Whether a completion that survived the debounce is worth saying out loud. */
    fun shouldNotify(stillIdle: Boolean, seen: Boolean, showingSession: Boolean): Boolean =
        stillIdle && !seen && !showingSession
}

/** Posts one "finished" notification per genuine completion, and stays silent otherwise. */
internal object CompletionNotifier {
    private const val CHANNEL = "agent_finished"
    private val lastStates = mutableMapOf<String, String>()
    private val pending = mutableMapOf<String, Job>()

    @Synchronized
    fun reconcile(context: Context, agents: List<Agent>, scope: CoroutineScope) {
        val appContext = context.applicationContext
        for (agent in agents) {
            when (CompletionPolicy.transition(lastStates[agent.id], agent.state)) {
                CompletionPolicy.Transition.StartDebounce -> {
                    pending.remove(agent.id)?.cancel()
                    pending[agent.id] = scope.launch {
                        delay(CompletionPolicy.DEBOUNCE_MS)
                        // Still running when the delay ends means no later
                        // snapshot cancelled it: the idle held.
                        finish(appContext, agent)
                    }
                }
                CompletionPolicy.Transition.CancelDebounce -> pending.remove(agent.id)?.cancel()
                CompletionPolicy.Transition.None -> Unit
            }
            lastStates[agent.id] = agent.state
        }
    }

    private fun finish(context: Context, agent: Agent) {
        synchronized(this) { pending.remove(agent.id) }
        // Seen is read at fire time, not capture time: opening the session
        // during the debounce second is exactly the case that should silence it.
        val seen = sessionSeen(agent, SeenStore(context).seenAt(agent.id))
        if (!CompletionPolicy.shouldNotify(stillIdle = true, seen = seen, showingSession = ForegroundSession.showing(agent.id))) return
        val manager = context.getSystemService(NotificationManager::class.java)
        // A channel of its own: completions are quieter news than approvals,
        // and a person who wants only one of the two can say so in settings.
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Agents finished", NotificationManager.IMPORTANCE_DEFAULT),
        )
        manager.notify("finished:${agent.id}".hashCode(), notification(context, agent))
    }

    private fun notification(context: Context, agent: Agent): Notification {
        val openIntent = PendingIntent.getActivity(
            context,
            "finished:${agent.id}".hashCode(),
            Intent(Intent.ACTION_VIEW, Uri.parse("agentdeck://agent/${Uri.encode(agent.id)}"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("${agent.name} finished")
            .setContentText("${agent.project} · ${agent.task}")
            .setStyle(Notification.BigTextStyle().bigText("${agent.project} · ${agent.task}"))
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .build()
    }
}
