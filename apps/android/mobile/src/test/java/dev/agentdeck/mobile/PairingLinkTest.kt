package dev.agentdeck.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingLinkTest {
    @Test
    fun `the QR's own link parses to its address and code`() {
        assertEquals(
            PairingLink("http://192.168.1.5:3000", "123456"),
            parsePairingLink("agentdeck://pair?url=http%3A%2F%2F192.168.1.5%3A3000&code=123456"),
        )
    }

    @Test
    fun `a tailnet HTTPS address is as good as a LAN one`() {
        assertEquals(
            PairingLink("https://bridge.tail1234.ts.net", "000042"),
            parsePairingLink("agentdeck://pair?url=https%3A%2F%2Fbridge.tail1234.ts.net&code=000042"),
        )
    }

    @Test
    fun `anything short of an address plus a six-digit code is refused`() {
        assertNull(parsePairingLink("agentdeck://pair?url=http%3A%2F%2Fx&code=12345"))
        assertNull(parsePairingLink("agentdeck://pair?code=123456"))
        assertNull(parsePairingLink("agentdeck://pair?url=ftp%3A%2F%2Fx&code=123456"))
        assertNull(parsePairingLink("agentdeck://agent/abc"))
        assertNull(parsePairingLink("https://example.com/?url=http%3A%2F%2Fx&code=123456"))
    }
}
