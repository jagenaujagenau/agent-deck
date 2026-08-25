package dev.agentdeck.mobile

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
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
import dev.agentdeck.shared.DeckSummaries
import dev.agentdeck.shared.DeckSummary
import dev.agentdeck.shared.DeckSummaryStore
import dev.agentdeck.shared.NeedsYou

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

@Composable
private fun DeckWidgetContent(summary: DeckSummary) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(GlanceTheme.colors.widgetBackground)
            .cornerRadius(16.dp)
            .padding(14.dp)
            .clickable(actionStartActivity(deckIntent(null))),
    ) {
        Header(summary)
        if (summary.needing.isEmpty()) return@Column
        Spacer(GlanceModifier.height(10.dp))
        for (needs in summary.needing) {
            NeedsYouRow(needs)
            Spacer(GlanceModifier.height(8.dp))
        }
        val hidden = DeckSummaries.overflow(summary, summary.needing.size)
        if (hidden > 0) {
            // Never silently truncated: three of six shown without saying so
            // would tell you the other three are fine.
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
            text = if (summary.attention > 0) "${summary.attention} need you" else "Agent Deck",
            style = TextStyle(
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                color = if (summary.attention > 0) ColorProvider(Attention) else GlanceTheme.colors.onSurface,
            ),
        )
        Spacer(GlanceModifier.defaultWeight())
        Text(
            text = DeckSummaries.restingLine(summary),
            style = TextStyle(fontSize = 11.sp, color = GlanceTheme.colors.onSurfaceVariant),
        )
    }
}

@Composable
private fun NeedsYouRow(needs: NeedsYou) {
    Column(
        modifier = GlanceModifier
            .fillMaxWidth()
            .clickable(actionStartActivity(deckIntent(needs.agentId))),
    ) {
        Text(
            text = needs.project,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium, color = GlanceTheme.colors.onSurface),
            maxLines = 1,
        )
        Text(
            text = needs.asking,
            style = TextStyle(fontSize = 11.sp, color = GlanceTheme.colors.onSurfaceVariant),
            maxLines = 2,
        )
    }
}

class DeckWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = DeckWidget()
}
