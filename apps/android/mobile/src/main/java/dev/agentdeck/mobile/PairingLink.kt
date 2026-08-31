package dev.agentdeck.mobile

import java.net.URLDecoder

/**
 * The QR on the bridge's pairing page says `agentdeck://pair?url=…&code=…`.
 * Scanning it with the phone's camera lands here: the link is the whole
 * pairing ceremony — address and one-time code — so the app can connect
 * without anyone typing either.
 */
internal data class PairingLink(val url: String, val code: String)

internal fun parsePairingLink(link: String): PairingLink? {
    val query = link
        .takeIf { it.startsWith("agentdeck://pair?") }
        ?.substringAfter('?') ?: return null
    val fields = query.split('&').mapNotNull { pair ->
        val name = pair.substringBefore('=')
        val value = pair.substringAfter('=', "")
        if (name.isEmpty()) null else name to URLDecoder.decode(value, "UTF-8")
    }.toMap()
    val url = fields["url"]?.takeIf { it.startsWith("http://") || it.startsWith("https://") } ?: return null
    val code = fields["code"]?.takeIf { it.matches(Regex("\\d{6}")) } ?: return null
    return PairingLink(url, code)
}
