package dev.agentdeck.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*
import dev.agentdeck.shared.SubagentRun

/**
 * Which subagent to read, or the whole session.
 *
 * A list rather than a switch, because a session can be running several at
 * once and they are told apart by what they are doing, not by their ids.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SubagentPicker(
    runs: List<SubagentRun>,
    selected: String?,
    onPick: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    // Chosen once per opening: the sheet lands on the running work when there
    // is any, and the person takes it from there.
    var filter by remember { mutableStateOf(defaultSubagentFilter(runs)) }
    val running = runs.count { !it.finished }
    val done = runs.size - running
    val shown = filteredSubagentRuns(runs, filter, selected)
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp)) {
            Text("Subagents", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(3.dp))
            Text(
                "Work this session handed to an agent of its own.",
                color = Muted,
                fontSize = 13.sp,
                lineHeight = 18.sp,
            )
            Spacer(Modifier.height(10.dp))
            SubagentRow(
                title = "Whole session",
                subtitle = "Everything, including this session's own work",
                tint = Signal,
                running = false,
                selected = selected == null,
            ) { onPick(null) }
            // The chips carry counts so filtering is informed before a tap;
            // they only appear once both statuses exist to filter between.
            if (running > 0 && done > 0) {
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SubagentFilterChip("Running $running", filter == SubagentFilter.Running) {
                        filter = SubagentFilter.Running
                    }
                    SubagentFilterChip("Done $done", filter == SubagentFilter.Done) {
                        filter = SubagentFilter.Done
                    }
                    SubagentFilterChip("All ${runs.size}", filter == SubagentFilter.All) {
                        filter = SubagentFilter.All
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            // A busy session runs more lenses than a sheet is tall. The list
            // scrolls under the fixed header; `fill = false` keeps a short
            // list from stretching the sheet past its content.
            LazyColumn(
                modifier = Modifier.weight(1f, fill = false),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(shown, key = { it.id }) { run ->
                    SubagentRow(
                        title = run.title,
                        subtitle = run.activity,
                        tint = Blue,
                        running = !run.finished,
                        selected = selected == run.id,
                    ) { onPick(run.id) }
                }
            }
        }
    }
}

@Composable
internal fun SubagentFilterChip(label: String, active: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(99.dp),
        color = if (active) Blue.copy(alpha = 0.15f) else SurfaceRaised,
        border = BorderStroke(1.dp, if (active) Blue.copy(alpha = 0.45f) else Line),
    ) {
        Text(
            label,
            color = if (active) Text else Muted,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

@Composable
internal fun SubagentRow(
    title: String,
    subtitle: String,
    tint: Color,
    running: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        color = if (selected) tint.copy(alpha = 0.13f) else SurfaceRaised,
        border = if (selected) BorderStroke(1.dp, tint.copy(alpha = 0.4f)) else null,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(if (running) tint else Muted.copy(alpha = 0.5f)))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(2.dp))
                Text(subtitle, color = Muted, fontSize = 12.sp, lineHeight = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (selected) {
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Rounded.Check, "Showing this", tint = tint, modifier = Modifier.size(18.dp))
            }
        }
    }
}
