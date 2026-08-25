package dev.agentdeck.mobile

import android.content.Context
import androidx.glance.appwidget.updateAll
import dev.agentdeck.shared.BridgeSnapshot
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
    suspend fun onSnapshot(context: Context, snapshot: BridgeSnapshot) {
        val previous = DeckSummaryStore.read(context)
        // Archived sessions are filtered exactly as the app and the watch relay
        // filter them. A widget counting sessions the app on the same phone has
        // been told to hide is the disagreement the shared summary exists to
        // prevent - and it read "8 need you" beside an app showing two.
        val visible = archiveFilteredSnapshot(context, snapshot)
        val next = DeckSummaries.of(visible.agents, System.currentTimeMillis())
        // Redraw only on a change a person could see. A widget rewritten every
        // few seconds costs battery to display the same thing.
        if (!DeckSummaryStore.differs(previous, next)) return
        DeckSummaryStore.write(context, next)
        DeckWidget().updateAll(context)
    }
}
