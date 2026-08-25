package dev.agentdeck.mobile

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.agentdeck.shared.DeckLine
import dev.agentdeck.shared.DeckSummaries
import dev.agentdeck.shared.DeckSummary
import dev.agentdeck.shared.DeckSummaryStore

/**
 * The home screen widget: what is asking for you, without opening anything.
 *
 * Drawn entirely from the summary on disk. A widget composes on the system's
 * schedule, frequently with the app dead, so fetching here would mean a widget
 * that is blank exactly when it is most wanted - the refresh is somebody else's
 * job (see [DeckWidgetUpdater]).
 */
class DeckWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val summary = DeckSummaryStore.read(context)
        provideContent { GlanceTheme { DeckWidgetContent(summary) } }
    }
}

private val Attention = Color(0xFFE0A030)

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

/**
 * How many lines this widget has room for.
 *
 * Measured rather than fixed, because the same widget is placed at four cells
 * wide and at one. Each row is a project and a line of detail, and the header
 * takes the first slice of the height.
 */
internal fun rowsThatFit(height: Dp): Int =
    ((height.value - HEADER_HEIGHT) / ROW_HEIGHT).toInt().coerceIn(0, DeckSummaries.MAX_LINES)

private const val HEADER_HEIGHT = 34f
private const val ROW_HEIGHT = 40f

@Composable
private fun DeckWidgetContent(summary: DeckSummary) {
    val rows = rowsThatFit(LocalSize.current.height)
    val shown = summary.lines.take(rows)
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(GlanceTheme.colors.widgetBackground)
            .cornerRadius(16.dp)
            .padding(14.dp)
            .clickable(actionStartActivity(deckIntent(null))),
    ) {
        Header(summary)
        Spacer(GlanceModifier.height(8.dp))
        for (line in shown) {
            DeckRow(line)
            Spacer(GlanceModifier.height(6.dp))
        }
        val hidden = DeckSummaries.overflow(summary, shown.size)
        if (hidden > 0) {
            // Never silently truncated: three of eight shown without a word
            // would tell you the deck has three sessions.
            Text(
                text = "and $hidden more",
                style = TextStyle(fontSize = 11.sp, color = GlanceTheme.colors.onSurfaceVariant),
            )
        }
    }
}

@Composable
private fun Header(summary: DeckSummary) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = GlanceModifier.fillMaxWidth()) {
        Text(
            text = DeckSummaries.headline(summary),
            style = TextStyle(
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                color = if (summary.attention > 0) ColorProvider(Attention) else GlanceTheme.colors.onSurface,
            ),
        )
        Spacer(GlanceModifier.defaultWeight())
        if (summary.total > 0) {
            Text(
                text = "${summary.total} session${if (summary.total == 1) "" else "s"}",
                style = TextStyle(fontSize = 11.sp, color = GlanceTheme.colors.onSurfaceVariant),
            )
        }
    }
}

@Composable
private fun DeckRow(line: DeckLine) {
    Row(
        verticalAlignment = Alignment.Top,
        modifier = GlanceModifier
            .fillMaxWidth()
            .clickable(actionStartActivity(deckIntent(line.agentId))),
    ) {
        // A dot rather than a coloured row: the state has to survive a
        // launcher that tints widget text to match the wallpaper.
        Text(
            text = if (line.needsYou) "●" else "○",
            style = TextStyle(
                fontSize = 10.sp,
                color = if (line.needsYou) ColorProvider(Attention) else GlanceTheme.colors.onSurfaceVariant,
            ),
            modifier = GlanceModifier.padding(end = 6.dp, top = 2.dp),
        )
        Column {
            Text(
                text = line.project,
                style = TextStyle(
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = GlanceTheme.colors.onSurface,
                ),
                maxLines = 1,
            )
            Text(
                text = line.detail,
                style = TextStyle(fontSize = 11.sp, color = GlanceTheme.colors.onSurfaceVariant),
                maxLines = 1,
            )
        }
    }
}

class DeckWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DeckWidget()
}
