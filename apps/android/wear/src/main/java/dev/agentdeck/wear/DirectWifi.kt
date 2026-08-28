package dev.agentdeck.wear

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import javax.net.SocketFactory
import kotlinx.coroutines.delay

/**
 * The watch's own Wi-Fi, requested explicitly.
 *
 * Wear OS routes app traffic through the Bluetooth companion tunnel by
 * default — at both the proxy and the routing layer — where an address on the
 * LAN the watch itself sits on simply times out. Asking ConnectivityManager
 * for a Wi-Fi network is what turns the radio on and yields sockets that dial
 * the LAN directly; it is the platform's own pattern for high-bandwidth or
 * peer-local traffic.
 *
 * The request stays registered for the life of the process: releasing it after
 * each fetch would drop Wi-Fi mid-session and pay the multi-second reconnect
 * on every page.
 */
internal object DirectWifi {
    @Volatile private var network: Network? = null
    @Volatile private var requested = false

    /** Sockets bound to Wi-Fi, or null if none came up in time — callers then try the default path. */
    suspend fun socketFactory(context: Context): SocketFactory? {
        request(context)
        // The radio takes a moment when the request is what woke it.
        val deadline = System.currentTimeMillis() + 5_000
        while (network == null && System.currentTimeMillis() < deadline) delay(100)
        return network?.socketFactory
    }

    private fun request(context: Context) {
        if (requested) return
        synchronized(this) {
            if (requested) return
            requested = true
            val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
            val wifi = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            manager.requestNetwork(wifi, object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(available: Network) {
                    network = available
                }

                override fun onLost(lost: Network) {
                    if (network == lost) network = null
                }
            })
        }
    }
}
