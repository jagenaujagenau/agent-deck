package dev.agentdeck.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.math.ceil

internal enum class AnalyticsRange(val api: String, val label: String, val days: Long) {
    Day("day", "Day", 1), Week("week", "Week", 7), Month("month", "Month", 30),
    Quarter("quarter", "Quarter", 90), Year("year", "Year", 365),
}

@Composable
internal fun AnalyticsScreen(
    state: AnalyticsState,
    onLoad: (String, String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    var range by rememberSaveable { mutableStateOf(AnalyticsRange.Month) }
    var project by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(range, project) { onLoad(range.api, project) }
    val data = when (state) {
        is AnalyticsState.Ready -> state.data
        is AnalyticsState.Failed -> state.previous
        AnalyticsState.Loading -> null
    }

    if (data == null) {
        Box(
            modifier.padding(24.dp),
            // The skeleton stands in for content that starts at the top; centring
            // it left the screen with a header-shaped hole above it.
            contentAlignment = if (state is AnalyticsState.Failed) Alignment.Center else Alignment.TopCenter,
        ) {
            if (state is AnalyticsState.Failed) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Rounded.QueryStats, null, tint = Danger, modifier = Modifier.size(32.dp))
                    Text("Usage unavailable", fontWeight = FontWeight.SemiBold)
                    Text(state.message, color = Muted, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    TextButton(onClick = { onLoad(range.api, project) }) { Text("Try again") }
                }
            } else {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    repeat(4) { Box(Modifier.fillMaxWidth().height(if (it == 0) 130.dp else 72.dp).clip(RoundedCornerShape(20.dp)).background(SurfaceRaised)) }
                }
            }
        }
        return
    }

    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 18.dp, bottom = DeckNavSpace),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Usage", style = MaterialTheme.typography.headlineLarge)
                Text("Agent activity and spend over the past ${range.label.lowercase()}", color = Muted)
            }
        }
        item {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AnalyticsRange.entries.forEach { item ->
                    FilterChip(selected = range == item, onClick = { range = item }, shape = CircleShape, label = { Text(item.label) })
                }
            }
        }
        if (data.filters.projects.isNotEmpty()) item {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = project == null, onClick = { project = null }, shape = CircleShape, label = { Text("All projects") })
                data.filters.projects.forEach { name ->
                    FilterChip(selected = project == name, onClick = { project = name }, shape = CircleShape, label = { Text(name, maxLines = 1) })
                }
            }
        }
        item { UsageSummary(data.summary) }
        if (data.limits.isNotEmpty()) item { RateLimitSection(data.limits) }
        item { ActivityHeatmap(data.heatmap, range) }
        item { UsageTrend(data.series, range) }
        if (data.projects.isNotEmpty()) {
            item { SectionLabel("By project") }
            items(data.projects, key = { it.project }) { item -> ProjectUsageRow(item, data.summary.tokens) }
        }
        if (data.runtimes.isNotEmpty()) {
            item { SectionLabel("By runtime") }
            item {
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    data.runtimes.forEach { item -> RuntimeUsageCard(item) }
                }
            }
        }
        if (state is AnalyticsState.Failed) item { OfflineBanner(state.message) }
    }
}

@Composable
internal fun UsageSummary(summary: AnalyticsSummary) {
    Surface(shape = RoundedCornerShape(24.dp), color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(verticalAlignment = Alignment.Bottom) {
                Column(Modifier.weight(1f)) {
                    Text("PRICED COST", color = Muted, fontSize = 11.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.Bold)
                    // Plain, not amber: amber means something wants a person
                    // everywhere else in the deck, and a bill is not a request.
                    // Size already makes this the headline, and it leaves blue
                    // as the single accent in the card.
                    Text(formatMoney(summary.costUsd), fontSize = 38.sp, lineHeight = 42.sp, fontWeight = FontWeight.SemiBold, color = Text)
                    if (summary.costCoveragePercent < 99.9) Text("${summary.costCoveragePercent.toInt()}% token coverage · ${formatCompact(summary.unpricedTokens)} unpriced", color = Muted, fontSize = 11.sp)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("TOKENS", color = Muted, fontSize = 11.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.Bold)
                    Text(formatCompact(summary.tokens), fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = Blue)
                }
            }
            HorizontalDivider(color = Muted.copy(alpha = 0.16f))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                SmallMetric("Sessions", summary.sessions.toString())
                SmallMetric("Events", summary.events.toString())
                SmallMetric("Active days", summary.activeDays.toString())
            }
            val facets = summary.tokenFacets
            if (facets.uncachedInput + facets.cachedInput + facets.cacheCreation + facets.output > 0) {
                HorizontalDivider(color = Muted.copy(alpha = 0.16f))
                Text("TOKEN MIX", color = Muted, fontSize = 11.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.Bold)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    SmallMetric("Input", formatCompact(facets.uncachedInput))
                    SmallMetric("Cache read", formatCompact(facets.cachedInput))
                    SmallMetric("Cache write", formatCompact(facets.cacheCreation))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    SmallMetric("Output", formatCompact(facets.output))
                    SmallMetric("Reasoning*", formatCompact(facets.reasoning))
                    SmallMetric("Covered", formatCompact(facets.uncachedInput + facets.cachedInput + facets.cacheCreation + facets.output))
                }
                Text("* Reasoning is included in output totals.", color = Muted, fontSize = 10.sp)
            }
        }
    }
}

@Composable
internal fun SmallMetric(label: String, value: String) {
    Column {
        Text(value, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Text(label, color = Muted, fontSize = 12.sp)
    }
}

@Composable
internal fun RateLimitSection(limits: List<RateLimitWindow>) {
    Surface(shape = RoundedCornerShape(24.dp), color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Rate limits", style = MaterialTheme.typography.titleMedium)
                Text("Live provider windows", color = Muted, fontSize = 12.sp)
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                limits.forEach { limit -> RateLimitRing(limit) }
            }
        }
    }
}

@Composable
internal fun RateLimitRing(limit: RateLimitWindow) {
    val used = (limit.usedPercent / 100.0).toFloat().coerceIn(0f, 1f)
    val color = when { used >= 0.9f -> Danger; used >= 0.7f -> Amber; else -> Signal }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.width(82.dp)) {
        Box(Modifier.size(68.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(progress = { used }, modifier = Modifier.fillMaxSize(), color = color, trackColor = Line, strokeWidth = 6.dp)
            Text("${limit.usedPercent.toInt()}%", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        }
        Text(limit.label, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        Text(limit.runtime?.replaceFirstChar { it.uppercase() } ?: limit.account ?: "Provider", color = Muted, fontSize = 10.sp, maxLines = 1)
    }
}

@Composable
internal fun ActivityHeatmap(days: List<ActivityDay>, range: AnalyticsRange) {
    val today = remember { LocalDate.now(ZoneOffset.UTC) }
    val start = remember(range, today) { today.minusDays(range.days - 1).with(java.time.DayOfWeek.SUNDAY) }
    val end = remember(today) { today.plusDays((7 - today.dayOfWeek.value).toLong() % 7) }
    val values = remember(days) { days.associateBy { it.date } }
    val dates = remember(start, end) { generateSequence(start) { it.plusDays(1) }.takeWhile { !it.isAfter(end) }.toList() }
    val weeks = remember(dates) { dates.chunked(7) }
    val maxActivity = (days.maxOfOrNull { it.count } ?: 0).coerceAtLeast(1)
    var selected by remember { mutableStateOf<ActivityDay?>(null) }
    val scroll = rememberScrollState()
    LaunchedEffect(weeks.size) { withFrameNanos { }; scroll.scrollTo(scroll.maxValue) }

    Surface(shape = RoundedCornerShape(24.dp), color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Activity", style = MaterialTheme.typography.titleMedium)
                Text(plural(days.sumOf { it.count }, "event"), color = Muted, fontSize = 12.sp)
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                weeks.forEach { week ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        week.forEach { date ->
                            val day = values[date.toString()]
                            val level = if (day == null || day.count == 0) 0f else (day.count.toFloat() / maxActivity).coerceIn(0.2f, 1f)
                            Box(
                                Modifier.size(13.dp).clip(RoundedCornerShape(3.dp))
                                    .background(if (level == 0f) Muted.copy(alpha = 0.12f) else Signal.copy(alpha = 0.25f + level * 0.75f))
                                    .clickable(enabled = day != null) { selected = day },
                            )
                        }
                    }
                }
            }
            selected?.let { day ->
                Text("${day.date}  ·  ${day.count} events  ·  ${formatCompact(day.tokens)} tokens  ·  ${formatMoney(day.costUsd)}", color = Muted, fontSize = 12.sp)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("Less", color = Muted, fontSize = 10.sp)
                listOf(0.12f, 0.35f, 0.55f, 0.75f, 1f).forEach { alpha ->
                    Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(if (alpha == 0.12f) Muted.copy(alpha = alpha) else Signal.copy(alpha = alpha)))
                }
                Text("More", color = Muted, fontSize = 10.sp)
            }
        }
    }
}

@Composable
internal fun UsageTrend(points: List<AnalyticsPoint>, range: AnalyticsRange) {
    val maxTokens = (points.maxOfOrNull { it.tokens } ?: 0L).coerceAtLeast(1L)
    Surface(shape = RoundedCornerShape(24.dp), color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Token trend", style = MaterialTheme.typography.titleMedium)
                Text(if (range == AnalyticsRange.Year) "Monthly" else if (range == AnalyticsRange.Quarter) "Weekly" else "Daily", color = Muted, fontSize = 12.sp)
            }
            if (points.isEmpty()) Text("Usage will appear after agents report new token deltas.", color = Muted)
            else Row(
                Modifier.fillMaxWidth().height(100.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                points.forEach { point ->
                    val height = ceil(point.tokens.toDouble() / maxTokens * 88).toInt().coerceAtLeast(4)
                    Box(Modifier.width(14.dp).height(height.dp).clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp)).background(Blue.copy(alpha = 0.82f)))
                }
            }
        }
    }
}

@Composable
internal fun SectionLabel(text: String) {
    Text(text, color = Muted, fontSize = 12.sp, letterSpacing = 1.sp, fontWeight = FontWeight.Bold)
}

@Composable
internal fun ProjectUsageRow(item: ProjectUsage, totalTokens: Long) {
    val share = if (totalTokens <= 0) 0f else item.tokens.toFloat() / totalTokens
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text(item.project, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${plural(item.sessions, "session")} · ${plural(item.events, "event")}", color = Muted, fontSize = 12.sp)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(formatCompact(item.tokens), color = Blue, fontWeight = FontWeight.SemiBold)
                Text(formatMoney(item.costUsd), color = Muted, fontSize = 12.sp)
            }
        }
        LinearProgressIndicator(
            progress = { share.coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth().height(4.dp).clip(CircleShape),
            color = Signal,
            trackColor = Muted.copy(alpha = 0.12f),
            // Material parks a dot at the end of the track by default. On a
            // 4dp hairline it reads as a rendering artifact, not a marker.
            drawStopIndicator = {},
        )
    }
}

@Composable
internal fun RuntimeUsageCard(item: RuntimeUsage) {
    Surface(shape = RoundedCornerShape(18.dp), color = Surface, modifier = Modifier.width(150.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(item.runtime.replaceFirstChar { it.uppercase() }, color = Muted, fontSize = 12.sp)
            Text(formatCompact(item.tokens), fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = Blue)
            Text("${formatMoney(item.costUsd)} · ${plural(item.events, "event")}", color = Muted, fontSize = 11.sp)
        }
    }
}

/** "1 session", not "1 sessions". */
internal fun plural(count: Int, singular: String, many: String = singular + "s") =
    "$count ${if (count == 1) singular else many}"

internal fun formatCompact(value: Long): String = when {
    value >= 1_000_000_000 -> String.format("%.1fB", value / 1_000_000_000.0)
    value >= 1_000_000 -> String.format("%.1fM", value / 1_000_000.0)
    value >= 1_000 -> String.format("%.1fK", value / 1_000.0)
    else -> value.toString()
}.replace(".0", "")

internal fun formatMoney(value: Double): String = if (value < 0.01 && value > 0) "<$0.01" else String.format("$%.2f", value)
