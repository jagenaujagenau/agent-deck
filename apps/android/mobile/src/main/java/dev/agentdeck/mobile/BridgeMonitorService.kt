package dev.agentdeck.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.IBinder
import dev.agentdeck.shared.AgentRepository
import dev.agentdeck.shared.BridgeClient
import dev.agentdeck.shared.BridgeState
import dev.agentdeck.shared.SecureTokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

class BridgeMonitorService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var connectionJob: Job? = null
    private var observerJob: Job? = null
    private var repository: AgentRepository? = null
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { repository?.wake() }
        override fun onLost(network: Network) { repository?.wake() }
    }

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForeground(MONITOR_NOTIFICATION_ID, monitorNotification("Connecting to bridge…"))
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        connect()
        return START_STICKY
    }

    private fun connect() {
        connectionJob?.cancel()
        observerJob?.cancel()
        val preferences = getSharedPreferences("bridge", 0)
        val client = BridgeClient(
            preferences.getString("url", BuildConfig.BRIDGE_URL) ?: BuildConfig.BRIDGE_URL,
            SecureTokenStore(this).get(),
        )
        val repository = AgentRepository(client)
        this.repository = repository
        connectionJob = scope.launch { repository.stream() }
        observerJob = scope.launch {
            repository.state.collect { state ->
                val snapshot = when (state) {
                    is BridgeState.Ready -> state.snapshot
                    is BridgeState.Failed -> state.previous
                    BridgeState.Loading -> null
                }
                val manager = getSystemService(NotificationManager::class.java)
                if (snapshot == null) {
                    manager.notify(MONITOR_NOTIFICATION_ID, monitorNotification("Bridge unavailable · reconnecting"))
                    return@collect
                }
                val visibleSnapshot = archiveFilteredSnapshot(this@BridgeMonitorService, snapshot)
                WearBridgeRelay.publish(this@BridgeMonitorService, snapshot)
                val waiting = visibleSnapshot.agents.filter { it.state == "waiting" }
                val approvals = waiting.count { it.pendingApproval != null }
                val questions = waiting.count { agent -> agent.events.maxByOrNull { it.createdAt }?.kind == "question" }
                ApprovalNotifier.reconcile(this@BridgeMonitorService, snapshot.agents)
                DeckWidgetUpdater.onSnapshot(this@BridgeMonitorService, snapshot.agents)
                val status = when {
                    approvals > 0 -> "$approvals approval${if (approvals == 1) "" else "s"} waiting"
                    questions > 0 -> "$questions question${if (questions == 1) "" else "s"} waiting"
                    waiting.isNotEmpty() -> "${waiting.size} agent${if (waiting.size == 1) "" else "s"} need attention"
                    visibleSnapshot.summary.active > 0 -> "${visibleSnapshot.summary.active} agent${if (visibleSnapshot.summary.active == 1) "" else "s"} active"
                    else -> "Agents idle"
                }
                manager.notify(MONITOR_NOTIFICATION_ID, monitorNotification(status))
            }
        }
    }

    private fun monitorNotification(status: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            MONITOR_NOTIFICATION_ID,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, MONITOR_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Agent Deck is monitoring")
            .setContentText(status)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun createChannels() {
        getSystemService(NotificationManager::class.java).createNotificationChannels(
            listOf(NotificationChannel(MONITOR_CHANNEL, "Bridge monitoring", NotificationManager.IMPORTANCE_LOW)),
        )
    }

    override fun onDestroy() {
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
        repository = null
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val MONITOR_CHANNEL = "bridge_monitor"
        private const val MONITOR_NOTIFICATION_ID = 7401
    }
}
