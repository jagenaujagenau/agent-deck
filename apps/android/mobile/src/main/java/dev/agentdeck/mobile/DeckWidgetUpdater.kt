package dev.agentdeck.mobile

import android.content.Context
import androidx.glance.appwidget.updateAll
import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.DeckSummaries
import dev.agentdeck.shared.DeckSummaryStore

/**
 * Keeps the widget's stored summary in step with the deck.
 *
 * Called from wherever a snapshot already arrives rather than polling on its
 * own: the monitor service is already streaming, and a widget with a second
 * connection to the same bridge would be paying twice to learn the same thing.
 */
object DeckWidgetUpdater {
    suspend fun onSnapshot(context: Context, agents: List<Agent>) {
        val previous = DeckSummaryStore.read(context)
        val next = DeckSummaries.of(agents, System.currentTimeMillis())
        // Redraw only on a change a person could see. A widget rewritten every
        // few seconds costs battery to display the same thing.
        if (!DeckSummaryStore.differs(previous, next)) return
        DeckSummaryStore.write(context, next)
        DeckWidget().updateAll(context)
    }
}
