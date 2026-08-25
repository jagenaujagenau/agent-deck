package dev.agentdeck.wear

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DeviceParametersBuilders
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import dev.agentdeck.shared.DeckLine
import dev.agentdeck.shared.DeckSummaries
import dev.agentdeck.shared.DeckSummary
import dev.agentdeck.shared.DeckSummaryStore

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
 * It speaks the same way the phone widget does - a prompt, the same markers,
 * the same colours - but not in the same face. ProtoLayout has no font family
 * to set: weight, colour, italic and letter spacing are the whole vocabulary,
 * so a monospace tile is not something that can be asked for. Tracking on the
 * headline is the nearest honest equivalent.
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
                    TimelineBuilders.Timeline.fromLayoutElement(
                        layout(summary, screen(requestParams.deviceConfiguration)),
                    ),
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

/** The screen a tile has been handed, reduced to what the layout needs. */
internal data class Screen(val widthDp: Float, val heightDp: Float, val round: Boolean)

private fun screen(device: DeviceParametersBuilders.DeviceParameters) = Screen(
    widthDp = device.screenWidthDp.toFloat(),
    heightDp = device.screenHeightDp.toFloat(),
    round = device.screenShape == DeviceParametersBuilders.SCREEN_SHAPE_ROUND,
)

/* The phone widget's terminal palette, so the two surfaces read as one product. */
private const val FOREGROUND = 0xFFC9D1D9.toInt()
private const val MUTED = 0xFF8B949E.toInt()
private const val PROMPT = 0xFF3FB950.toInt()
private const val ATTENTION = 0xFFD29922.toInt()

/**
 * How far in from the edge content has to start.
 *
 * A round screen has no corners to write into: text at the full width is fine
 * across the middle and clipped at the top and bottom, which is exactly where
 * the headline and the overflow line sit. The inset is what a rectangle
 * inscribed in the circle can afford, rounded down.
 */
internal fun horizontalInset(screen: Screen): Float =
    if (screen.round) screen.widthDp * 0.14f else screen.widthDp * 0.06f

/** Two rows is what fits under a headline on a small round face without crowding. */
internal fun rowsThatFit(screen: Screen): Int =
    (((screen.heightDp * 0.72f) - HEADLINE_HEIGHT) / ROW_HEIGHT)
        .toInt()
        .coerceIn(0, if (screen.round) 3 else DeckSummaries.MAX_LINES)

private const val HEADLINE_HEIGHT = 26f
private const val ROW_HEIGHT = 34f

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

private fun text(
    value: String,
    size: Float,
    color: Int,
    maxLines: Int = 1,
    weight: Int = LayoutElementBuilders.FONT_WEIGHT_NORMAL,
    tracking: Float = 0f,
) = LayoutElementBuilders.Text.Builder()
    .setText(value)
    .setMaxLines(maxLines)
    .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE)
    .setFontStyle(
        LayoutElementBuilders.FontStyle.Builder()
            .setSize(sp(size))
            .setColor(argb(color))
            .setWeight(weight)
            .apply {
                if (tracking != 0f) {
                    setLetterSpacing(androidx.wear.protolayout.DimensionBuilders.em(tracking))
                }
            }
            .build(),
    )
    .build()

internal fun layout(
    summary: DeckSummary,
    screen: Screen,
): LayoutElementBuilders.LayoutElement {
    val inset = horizontalInset(screen)
    val shown = summary.lines.take(rowsThatFit(screen))

    val column = LayoutElementBuilders.Column.Builder()
        .setWidth(expand())
        .setModifiers(openApp(null))
        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)

    // The prompt and the headline on one line, so the tile opens the way the
    // widget does rather than merely sharing its colours.
    column.addContent(
        LayoutElementBuilders.Row.Builder()
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .addContent(text("❯ ", 14f, PROMPT, weight = LayoutElementBuilders.FONT_WEIGHT_BOLD))
            .addContent(
                text(
                    DeckSummaries.headline(summary),
                    15f,
                    if (summary.attention > 0) ATTENTION else FOREGROUND,
                    weight = LayoutElementBuilders.FONT_WEIGHT_MEDIUM,
                    // Tracking is the nearest ProtoLayout gets to a terminal face.
                    tracking = 0.04f,
                ),
            )
            .build(),
    )

    for (line in shown) {
        column.addContent(spacer(9f))
        column.addContent(deckRow(line))
    }

    val hidden = DeckSummaries.overflow(summary, shown.size)
    if (hidden > 0) {
        column.addContent(spacer(7f))
        // Said rather than truncated: two of five shown without a word would
        // report that the other three do not need you.
        column.addContent(text("… $hidden more", 12f, MUTED))
    }

    return LayoutElementBuilders.Box.Builder()
        .setWidth(expand())
        .setHeight(expand())
        .setModifiers(
            ModifiersBuilders.Modifiers.Builder()
                .setPadding(
                    ModifiersBuilders.Padding.Builder()
                        .setStart(dp(inset))
                        .setEnd(dp(inset))
                        .build(),
                )
                .build(),
        )
        .addContent(column.build())
        .build()
}

private fun deckRow(line: DeckLine): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Column.Builder()
        .setWidth(expand())
        .setModifiers(openApp(line.agentId))
        // Left-aligned, unlike the headline above it. Centring each row
        // independently put every marker at a different distance from the edge,
        // which reads as a ragged list rather than a centred one.
        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_START)
        .addContent(
            LayoutElementBuilders.Row.Builder()
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                // The marker differs in shape as well as colour, so the state
                // survives a watch face someone has set to greyscale.
                .addContent(
                    text(
                        if (line.needsYou) "● " else "○ ",
                        10f,
                        if (line.needsYou) ATTENTION else MUTED,
                    ),
                )
                .addContent(
                    text(
                        line.project,
                        14f,
                        if (line.needsYou) ATTENTION else FOREGROUND,
                        weight = LayoutElementBuilders.FONT_WEIGHT_MEDIUM,
                    ),
                )
                .build(),
        )
        .addContent(text(line.detail, 12f, MUTED, maxLines = 2))
        .build()

private fun spacer(height: Float) =
    LayoutElementBuilders.Spacer.Builder().setHeight(dp(height)).build()
