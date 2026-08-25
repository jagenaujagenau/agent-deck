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
import dev.agentdeck.shared.Harness

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

    /**
     * The harness marks, which a tile has to hand over rather than reference.
     *
     * A tile is rendered in the system's process, so a drawable id means nothing
     * there until it has been mapped to a name the layout can ask for.
     */
    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> {
        val resources = ResourceBuilders.Resources.Builder().setVersion(RESOURCES)
        for (harness in Harness.entries) {
            val icon = harness.icon ?: continue
            resources.addIdToImageMapping(
                harness.name,
                ResourceBuilders.ImageResource.Builder()
                    .setAndroidResourceByResId(
                        ResourceBuilders.AndroidImageResourceByResId.Builder()
                            .setResourceId(icon)
                            .build(),
                    )
                    .build(),
            )
        }
        return Futures.immediateFuture(resources.build())
    }

    private companion object {
        // Bumped whenever the mapping above changes, or the watch keeps serving
        // the set it cached.
        const val RESOURCES = "2"
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
private const val CARD = 0xFF141920.toInt()
private const val BADGE = 0xFF20262F.toInt()

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
private const val ROW_HEIGHT = 52f

/** Opens the watch app, at one session when the tap named one. */
private fun openApp(agentId: String?): ModifiersBuilders.Modifiers =
    ModifiersBuilders.Modifiers.Builder().setClickable(clickable(agentId)).build()

private fun clickable(agentId: String?): ModifiersBuilders.Clickable =
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

/**
 * The tile, in the shape Wear tiles are: a badge, a title, one card, a button.
 *
 * Matched to the system's own tiles rather than invented. A tile that lays
 * itself out differently from every other tile in the carousel reads as a
 * foreign object no matter how good it looks on its own.
 */
internal fun layout(
    summary: DeckSummary,
    screen: Screen,
): LayoutElementBuilders.LayoutElement {
    val inset = horizontalInset(screen)
    val shown = summary.lines.take(rowsThatFit(screen))
    val card = LayoutElementBuilders.Column.Builder()
        .setWidth(expand())
        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_START)

    if (shown.isEmpty()) {
        card.addContent(text(DeckSummaries.headline(summary), 13f, MUTED))
    }
    shown.forEachIndexed { index, line ->
        if (index > 0) card.addContent(spacer(9f))
        card.addContent(deckRow(line))
    }
    val hidden = DeckSummaries.overflow(summary, shown.size)
    if (hidden > 0) {
        card.addContent(spacer(6f))
        // Said rather than truncated: two of five shown without a word would
        // report that the other three do not need you.
        card.addContent(text("… $hidden more", 11f, MUTED))
    }

    return LayoutElementBuilders.Column.Builder()
        .setWidth(expand())
        .setHeight(expand())
        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
        .setModifiers(
            ModifiersBuilders.Modifiers.Builder()
                .setPadding(
                    ModifiersBuilders.Padding.Builder()
                        .setStart(dp(inset)).setEnd(dp(inset))
                        .setTop(dp(screen.heightDp * 0.05f))
                        .setBottom(dp(screen.heightDp * 0.05f))
                        .build(),
                )
                .build(),
        )
        // The app's own badge, the way every tile in the carousel opens.
        .addContent(appBadge(summary))
        .addContent(spacer(4f))
        .addContent(
            text(
                DeckSummaries.headline(summary),
                15f,
                if (summary.attention > 0) ATTENTION else FOREGROUND,
                weight = LayoutElementBuilders.FONT_WEIGHT_MEDIUM,
            ),
        )
        .addContent(spacer(7f))
        // One card holding the whole deck, which is the shape of a Wear tile.
        .addContent(
            LayoutElementBuilders.Box.Builder()
                .setWidth(expand())
                .setModifiers(cardSurface(CARD, 22f, null))
                .addContent(card.build())
                .build(),
        )
        .build()
}

/** The circular mark every Wear tile leads with, so this one is recognisable too. */
private fun appBadge(summary: DeckSummary): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Box.Builder()
        .setWidth(dp(26f))
        .setHeight(dp(26f))
        .setModifiers(
            ModifiersBuilders.Modifiers.Builder()
                .setBackground(
                    ModifiersBuilders.Background.Builder()
                        .setColor(argb(BADGE))
                        .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(13f)).build())
                        .build(),
                )
                .setClickable(clickable(null))
                .build(),
        )
        .addContent(
            text(
                "❯",
                13f,
                if (summary.attention > 0) ATTENTION else PROMPT,
                weight = LayoutElementBuilders.FONT_WEIGHT_BOLD,
            ),
        )
        .build()

/** A rounded surface that opens a session, which is what makes a row a card. */
private fun cardSurface(color: Int, radius: Float, agentId: String?) =
    ModifiersBuilders.Modifiers.Builder()
        .setBackground(
            ModifiersBuilders.Background.Builder()
                .setColor(argb(color))
                .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(radius)).build())
                .build(),
        )
        .setPadding(
            ModifiersBuilders.Padding.Builder()
                .setStart(dp(7f)).setEnd(dp(7f)).setTop(dp(6f)).setBottom(dp(6f))
                .build(),
        )
        .setClickable(clickable(agentId))
        .build()

/**
 * One session as a card: an avatar on the left, what it is doing on the right.
 *
 * The avatar is a fixed square so every card shares a text edge, and the
 * activity wraps inside the right column rather than running back under the
 * badge.
 */
private fun deckRow(line: DeckLine): LayoutElementBuilders.LayoutElement {
    val accent = if (line.needsYou) ATTENTION else PROMPT
    return LayoutElementBuilders.Box.Builder()
        .setWidth(expand())
        .setModifiers(cardSurface(CARD, 8f, line.agentId))
        .addContent(
            LayoutElementBuilders.Row.Builder()
                .setWidth(expand())
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_TOP)
                .addContent(avatar(line, accent))
                .addContent(LayoutElementBuilders.Spacer.Builder().setWidth(dp(7f)).build())
                .addContent(
                    LayoutElementBuilders.Column.Builder()
                        .setWidth(expand())
                        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_START)
                        .addContent(
                            text(
                                line.project,
                                13f,
                                if (line.needsYou) ATTENTION else FOREGROUND,
                                weight = LayoutElementBuilders.FONT_WEIGHT_MEDIUM,
                            ),
                        )
                        // The activity feed: thinking, or the last thing said.
                        .addContent(text(line.detail, 11f, MUTED, maxLines = 2))
                        .build(),
                )
                .build(),
        )
        .build()
}

/**
 * The harness's own mark, boxed so it reads as a badge.
 *
 * Falls back to the monogram for a runtime that ships no mark, rather than
 * drawing an empty square - a blank badge says the session has no harness,
 * which is never what is meant.
 */
private fun avatar(line: DeckLine, accent: Int): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Box.Builder()
        .setWidth(dp(24f))
        .setHeight(dp(24f))
        .setModifiers(
            ModifiersBuilders.Modifiers.Builder()
                .setBackground(
                    ModifiersBuilders.Background.Builder()
                        .setColor(argb(BADGE))
                        .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(5f)).build())
                        .build(),
                )
                .build(),
        )
        .addContent(
            if (line.harness.icon != null) {
                LayoutElementBuilders.Image.Builder()
                    .setResourceId(line.harness.name)
                    .setWidth(dp(15f))
                    .setHeight(dp(15f))
                    .build()
            } else {
                text(line.harness.mark, 11f, accent, weight = LayoutElementBuilders.FONT_WEIGHT_BOLD)
            },
        )
        .build()

private fun spacer(height: Float) =
    LayoutElementBuilders.Spacer.Builder().setHeight(dp(height)).build()
