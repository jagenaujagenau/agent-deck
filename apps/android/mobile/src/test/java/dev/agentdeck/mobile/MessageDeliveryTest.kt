package dev.agentdeck.mobile

import dev.agentdeck.shared.MessageDelivery
import dev.agentdeck.shared.deliveryFor
import dev.agentdeck.shared.deliveryNotice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class MessageDeliveryTest {
    @Test
    fun `a running session needs no explanation`() {
        // Its turn ends on its own, and the Stop hook hands the message over then.
        assertNull(deliveryNotice("running"))
    }

    @Test
    fun `an idle session says the message is waiting`() {
        // The exact case that looked like nothing happening: accepted, queued,
        // and no turn boundary to deliver at.
        assertEquals(MessageDelivery.WhenSessionResumes, deliveryFor("idle"))
        assertNotNull(deliveryNotice("idle"))
    }

    @Test
    fun `waiting and paused sessions are queued too`() {
        for (state in listOf("waiting", "paused", "error")) {
            assertEquals(state, MessageDelivery.WhenSessionResumes, deliveryFor(state))
        }
    }

    @Test
    fun `an offline session says it may never collect the message`() {
        assertEquals(MessageDelivery.Unreachable, deliveryFor("offline"))
        assertEquals(true, deliveryNotice("offline")!!.contains("offline"))
    }

    @Test
    fun `a state this build does not know is treated as queued, not delivered`() {
        // A newer runtime reporting a state this app predates must not read as sent.
        assertEquals(MessageDelivery.WhenSessionResumes, deliveryFor("compacting"))
    }
}
