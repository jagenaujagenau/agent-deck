package dev.agentdeck.wear

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import dev.agentdeck.shared.DeckSummaries
import dev.agentdeck.shared.DeckSummary
import dev.agentdeck.shared.DeckSummaryStore
import dev.agentdeck.shared.DeckLine

/**
 * The watch tile: what is asking for you, one swipe from the watch face.
 *
 * Built from the summary already on disk rather than fetched here. A tile is
 * rendered on the system's schedule and given a short budget to answer in, and
 * the watch does not always have a route to the bridge - so a tile that fetched
 * would be blank on exactly the walk-to-the-kitchen glance it exists for. The
 * listener service writes the summary whenever the phone relays one, with the
 * app open or closed.
 *
 * ProtoLayout rather than Compose because the watch renders a tile in its own
 * process: the layout is sent as data, not composed here.
 */
class DeckTile : TileService() {

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest,
    ): ListenableFuture<TileBuilders.Tile> {
        val summary = DeckSummaryStore.read(this)
        return Futures.immediateFuture(
            TileBuilders.Tile.Builder()
                .setResourcesVersion(RESOURCES)
                // Re-asked on this interval, which is the tile's only clock. The
                // relay usually beats it; this is what keeps a tile honest when
                // the phone has been out of range.
                .setFreshnessIntervalMillis(FRESHNESS_MS)
                .setTileTimeline(
                    TimelineBuilders.Timeline.fromLayoutElement(layout(summary)),
                )
                .build(),
        )
    }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        Futures.immediateFuture(
            ResourceBuilders.Resources.Builder().setVersion(RESOURCES).build(),
        )

    private companion object {
        const val RESOURCES = "1"
        const val FRESHNESS_MS = 10 * 60 * 1000L
    }
}

private const val ATTENTION = 0xFFE0A030.toInt()
private const val ON_SURFACE = 0xFFEFEFEF.toInt()
private const val MUTED = 0xFF9A9A9A.toInt()

/** Opens the watch app, at one session when the tap named one. */
private fun openApp(agentId: String?): ModifiersBuilders.Modifiers =
    ModifiersBuilders.Modifiers.Builder()
        .setClickable(
            ModifiersBuilders.Clickable.Builder()
                .setId(agentId ?: "deck")
                .setOnClick(
                    ActionBuilders.LaunchAction.Builder()
                        .setAndroidActivity(
                            ActionBuilders.AndroidActivity.Builder()
                                .setPackageName("dev.agentdeck")
                                .setClassName("dev.agentdeck.wear.WearActivity")
                                .apply {
                                    if (agentId != null) {
                                        addKeyToExtraMapping(
                                            WearActivity.EXTRA_AGENT_ID,
                                            ActionBuilders.stringExtra(agentId),
                                        )
                                    }
                                }
                                .build(),
                        )
                        .build(),
                )
                .build(),
        )
        .build()

private fun text(value: String, size: Float, color: Int, maxLines: Int = 1) =
    LayoutElementBuilders.Text.Builder()
        .setText(value)
        .setMaxLines(maxLines)
        .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE)
        .setFontStyle(
            LayoutElementBuilders.FontStyle.Builder()
                .setSize(androidx.wear.protolayout.DimensionBuilders.sp(size))
                .setColor(argb(color))
                .build(),
        )
        .build()

internal fun layout(summary: DeckSummary): LayoutElementBuilders.LayoutElement {
    val column = LayoutElementBuilders.Column.Builder()
        .setWidth(expand())
        .setModifiers(openApp(null))
        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)

    column.addContent(
        text(
            DeckSummaries.headline(summary),
            16f,
            if (summary.attention > 0) ATTENTION else ON_SURFACE,
        ),
    )

    // A watch face is glanced at, so the tile shows fewer than the phone - but
    // it shows what is working when nothing is waiting, rather than a headline
    // over an empty circle.
    val shown = summary.lines.take(MAX_ROWS)
    for (line in shown) {
        column.addContent(spacer(8f))
        column.addContent(deckRow(line))
    }

    val hidden = DeckSummaries.overflow(summary, shown.size)
    if (hidden > 0) {
        column.addContent(spacer(6f))
        // Said rather than truncated: two of five shown without a word would
        // report that the other three do not need you.
        column.addContent(text("and $hidden more", 12f, MUTED))
    }
    return column.build()
}

/** Two rows is what a round face fits under a headline without crowding. */
private const val MAX_ROWS = 2

private fun deckRow(line: DeckLine): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Column.Builder()
        .setWidth(expand())
        .setModifiers(openApp(line.agentId))
        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
        .addContent(text(line.project, 14f, if (line.needsYou) ATTENTION else ON_SURFACE))
        .addContent(text(line.detail, 12f, MUTED, maxLines = 2))
        .build()

private fun spacer(height: Float) =
    LayoutElementBuilders.Spacer.Builder()
        .setHeight(androidx.wear.protolayout.DimensionBuilders.dp(height))
        .build()
