package dev.agentdeck.mobile

import dev.agentdeck.mobile.CompletionPolicy.Transition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompletionPolicyTest {
    @Test
    fun onlyObservedRunningToIdleOpensTheWindow() {
        assertEquals(Transition.StartDebounce, CompletionPolicy.transition("running", "idle"))
        // A session first seen idle proves nothing about when it finished.
        assertEquals(Transition.None, CompletionPolicy.transition(null, "idle"))
        assertEquals(Transition.None, CompletionPolicy.transition("idle", "idle"))
        assertEquals(Transition.None, CompletionPolicy.transition("waiting", "idle"))
    }

    @Test
    fun anyMoveOffIdleClosesTheWindow() {
        // Back to running is the flicker the debounce exists for.
        assertEquals(Transition.CancelDebounce, CompletionPolicy.transition("idle", "running"))
        // Into blocked or error is the attention flow's story, not completion's.
        assertEquals(Transition.CancelDebounce, CompletionPolicy.transition("idle", "waiting"))
        assertEquals(Transition.CancelDebounce, CompletionPolicy.transition("idle", "error"))
        assertEquals(Transition.CancelDebounce, CompletionPolicy.transition("idle", "offline"))
    }

    @Test
    fun aSurvivedDebounceStaysSilentForSeenOrOnScreenSessions() {
        assertTrue(CompletionPolicy.shouldNotify(stillIdle = true, seen = false, showingSession = false))
        assertFalse(CompletionPolicy.shouldNotify(stillIdle = true, seen = true, showingSession = false))
        assertFalse(CompletionPolicy.shouldNotify(stillIdle = true, seen = false, showingSession = true))
        assertFalse(CompletionPolicy.shouldNotify(stillIdle = false, seen = false, showingSession = false))
    }

    @Test
    fun theDebounceIsAboutASecond() {
        // The asymmetry in one number: into working or blocked is instant
        // everywhere, into "done" needs this much proof.
        assertEquals(1_000L, CompletionPolicy.DEBOUNCE_MS)
    }
}
