package dev.agentdeck.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.agentdeck.shared.DeckLine
import dev.agentdeck.shared.DeckSummaries
import dev.agentdeck.shared.DeckSummary
import dev.agentdeck.shared.DeckSummaryStore

/**
 * The home screen widget, drawn as a terminal window.
 *
 * The sessions on the deck are terminal sessions, so the widget looks like the
 * thing it reports on. That is also why it does not follow the launcher's light
 * theme: a terminal is dark, and a pale one would read as a card pretending to
 * be a terminal rather than a window onto one.
 *
 * Drawn entirely from the summary on disk. A widget composes on the system's
 * schedule, frequently with the app dead, so fetching here would mean a widget
 * that is blank exactly when it is most wanted - the refresh is somebody else's
 * job (see [DeckWidgetUpdater]).
 */
class DeckWidget : GlanceAppWidget() {
    /**
     * The size actually granted, not the minimum declared.
     *
     * The default reports the provider's `minHeight` no matter how large the
     * widget was placed, so a card with room for six sessions drew one and said
     * "and 1 more" underneath all that empty space.
     */
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val summary = DeckSummaryStore.read(context)
        provideContent { TerminalWindow(summary) }
    }
}

/* A terminal palette, fixed rather than themed - see the class comment. */
private val Window = Color(0xFF0D1117)
private val TitleBar = Color(0xFF161B22)
private val Foreground = Color(0xFFC9D1D9)
private val WidgetMuted = Color(0xFF8B949E)
private val Card = Color(0xFF141920)
private val Badge = Color(0xFF20262F)
private val Prompt = Color(0xFF3FB950)
private val Attention = Color(0xFFD29922)
private val Close = Color(0xFFFF5F57)
private val Minimise = Color(0xFFFEBC2E)
private val Zoom = Color(0xFF28C840)

private const val TITLE_BAR_HEIGHT = 30f
private const val PROMPT_HEIGHT = 26f
private const val ROW_HEIGHT = 46f

/** How many sessions fit under the title bar and the prompt line. */
internal fun rowsThatFit(height: Dp): Int =
    ((height.value - TITLE_BAR_HEIGHT - PROMPT_HEIGHT) / ROW_HEIGHT)
        .toInt()
        .coerceIn(0, DeckSummaries.MAX_LINES)

private fun mono(size: Float, color: Color, weight: FontWeight = FontWeight.Normal) = TextStyle(
    fontSize = size.sp,
    fontFamily = FontFamily.Monospace,
    fontWeight = weight,
    color = ColorProvider(color),
)

@Composable
private fun TerminalWindow(summary: DeckSummary) {
    val rows = rowsThatFit(LocalSize.current.height)
    val shown = summary.lines.take(rows)
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(Window)
            // Square-ish on purpose. Measured on a Pixel at density 420, the
            // launcher renders whatever radius is asked for rather than
            // clipping to a larger system one, so this is the corner you see.
            .cornerRadius(4.dp)
            .clickable(actionStartActivity(deckIntent(null))),
    ) {
        TitleBar(summary)
        Column(modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp)) {
            PromptLine(summary)
            for (line in shown) {
                Spacer(GlanceModifier.height(5.dp))
                SessionCard(line)
            }
            val hidden = DeckSummaries.overflow(summary, shown.size)
            if (hidden > 0) {
                Spacer(GlanceModifier.height(4.dp))
                // Never silently truncated: three of eight shown without a word
                // would tell you the deck has three sessions.
                Text(text = "  … $hidden more", style = mono(11f, WidgetMuted))
            }
            // A resting cursor under the last line. The deck is usually small
            // enough to leave space below it, and in a terminal that space is
            // what waiting looks like - without this it just reads as a card
            // that failed to fill.
            Spacer(GlanceModifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text = "❯ ", style = mono(12f, Prompt, FontWeight.Bold))
                Text(text = "▊", style = mono(11f, WidgetMuted))
            }
        }
    }
}

/** The macOS window chrome, which is what makes it read as a window. */
@Composable
private fun TitleBar(summary: DeckSummary) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = GlanceModifier.fillMaxWidth().background(TitleBar).padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        // Glyphs rather than rounded boxes: an arbitrary corner radius needs
        // API 31, and these are perfect circles everywhere without it.
        Text(text = "●", style = mono(11f, Close))
        Text(text = " ●", style = mono(11f, Minimise))
        Text(text = " ●", style = mono(11f, Zoom))
        Spacer(GlanceModifier.width(10.dp))
        Text(
            text = "agent-deck",
            style = mono(11f, WidgetMuted),
            maxLines = 1,
        )
    }
}

/** The headline, as a command someone just ran. */
@Composable
private fun PromptLine(summary: DeckSummary) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = GlanceModifier.fillMaxWidth()) {
        Text(text = "❯ ", style = mono(12f, Prompt, FontWeight.Bold))
        Text(
            text = DeckSummaries.headline(summary),
            style = mono(13f, if (summary.attention > 0) Attention else Foreground, FontWeight.Bold),
            maxLines = 1,
        )
    }
}

/**
 * One session as a card: an avatar on the left, what it is doing on the right.
 *
 * The two columns are the point. The avatar holds a fixed width so every card
 * has the same text edge, and the activity wraps inside the right column rather
 * than running back under the badge - a wrapped line that reaches the card's
 * edge loses the column it belonged to.
 */
@Composable
private fun SessionCard(line: DeckLine) {
    val accent = if (line.needsYou) Attention else Prompt
    Row(
        // Centred against the whole card, so the badge sits level with the pair
        // of lines beside it rather than riding up against the project name.
        verticalAlignment = Alignment.CenterVertically,
        modifier = GlanceModifier
            .fillMaxWidth()
            .background(Card)
            .cornerRadius(6.dp)
            .padding(horizontal = 8.dp, vertical = 7.dp)
            .clickable(actionStartActivity(deckIntent(line.agentId))),
    ) {
        Avatar(line, accent)
        Spacer(GlanceModifier.width(8.dp))
        Column(modifier = GlanceModifier.defaultWeight()) {
            Text(
                text = line.project,
                style = mono(12f, if (line.needsYou) Attention else Foreground, FontWeight.Medium),
                maxLines = 1,
            )
            // The activity feed: what it is thinking, or the last thing it said.
            Text(text = line.detail, style = mono(10f, WidgetMuted), maxLines = 2)
        }
    }
}

/**
 * The harness's own mark, boxed so it reads as a badge.
 *
 * Falls back to the monogram for a runtime that ships no mark, rather than
 * drawing an empty square - a blank badge says the session has no harness,
 * which is never what is meant.
 */
@Composable
private fun Avatar(line: DeckLine, accent: Color) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = GlanceModifier
            .size(26.dp)
            .background(Badge)
            .cornerRadius(5.dp),
    ) {
        val icon = line.harness.icon
        if (icon != null) {
            Image(
                provider = ImageProvider(icon),
                // The marks carry their own brand colours, which is the point of
                // using them; tinting would throw away what makes them legible
                // at a glance.
                contentDescription = line.harness.label,
                modifier = GlanceModifier.size(16.dp),
            )
        } else {
            Text(text = line.harness.mark, style = mono(11f, accent, FontWeight.Bold))
        }
    }
}

/**
 * Opens the app, at one session when there is one to open.
 *
 * The `agentdeck://agent/<id>` link the app already answers, rather than a new
 * extra only the widget would use - the notifications reach a session the same
 * way, and one deep link is one thing to keep working.
 */
private fun deckIntent(agentId: String?): Intent = Intent(Intent.ACTION_VIEW).apply {
    setClassName("dev.agentdeck", "dev.agentdeck.mobile.MainActivity")
    if (agentId != null) data = Uri.parse("agentdeck://agent/$agentId")
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
}

class DeckWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DeckWidget()
}
