package dev.agentdeck.mobile

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.agentdeck.shared.BridgeClient
import dev.agentdeck.shared.SecureTokenStore
import kotlinx.coroutines.delay
import java.util.concurrent.TimeUnit

class BridgeRecoveryWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val preferences = applicationContext.getSharedPreferences("bridge", 0)
        val client = BridgeClient(
            preferences.getString("url", BuildConfig.BRIDGE_URL) ?: BuildConfig.BRIDGE_URL,
            SecureTokenStore(applicationContext).get(),
        )
        var lastError: Throwable? = null
        repeat(6) { attempt ->
            runCatching { client.snapshot() }
                .onSuccess { snapshot ->
                    WearBridgeRelay.publish(applicationContext, snapshot)
                    if (canNotify()) ApprovalNotifier.reconcile(applicationContext, snapshot.agents)
                    // The widget is redrawn even when notifications are
                    // refused: it is a surface a person chose to place, and
                    // it going stale is not the same as being alerted.
                    DeckWidgetUpdater.onSnapshot(applicationContext, snapshot)
                    applicationContext.getSharedPreferences("bridge_recovery", 0).edit()
                        .putLong("last_success_at", System.currentTimeMillis())
                        .remove("last_error")
                        .apply()
                    return Result.success()
                }
                .onFailure { lastError = it }
            if (attempt < 5 && !isStopped) delay(10_000)
        }
        applicationContext.getSharedPreferences("bridge_recovery", 0).edit()
            .putString("last_error", lastError?.message ?: "Bridge recovery failed")
            .apply()
        return Result.retry()
    }

    private fun canNotify() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

}

object RecoveryWorkScheduler {
    private const val IMMEDIATE_WORK = "agent-deck-recovery-now"
    private const val PERIODIC_WORK = "agent-deck-recovery-periodic"
    private val connected = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(context: Context) {
        val manager = WorkManager.getInstance(context)
        manager.enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<BridgeRecoveryWorker>(15, TimeUnit.MINUTES)
                .setConstraints(connected)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build(),
        )
        manager.enqueueUniqueWork(
            IMMEDIATE_WORK,
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<BridgeRecoveryWorker>()
                .setConstraints(connected)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build(),
        )
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            RecoveryWorkScheduler.schedule(context)
        }
    }
}
