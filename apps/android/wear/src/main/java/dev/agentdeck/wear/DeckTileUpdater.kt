package dev.agentdeck.wear

import android.content.Context
import androidx.wear.tiles.TileService
import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.DeckSummaries
import dev.agentdeck.shared.DeckSummaryStore

/** Keeps the tile's stored summary, and the tile itself, in step with the deck. */
object DeckTileUpdater {
    fun onSnapshot(context: Context, agents: List<Agent>) {
        val previous = DeckSummaryStore.read(context)
        val next = DeckSummaries.of(agents, System.currentTimeMillis())
        // Only ask for a redraw when a person could see the difference. A tile
        // update is a system round trip, and the relay arrives far more often
        // than the deck actually changes.
        if (!DeckSummaryStore.differs(previous, next)) return
        DeckSummaryStore.write(context, next)
        TileService.getUpdater(context).requestUpdate(DeckTile::class.java)
    }
}
