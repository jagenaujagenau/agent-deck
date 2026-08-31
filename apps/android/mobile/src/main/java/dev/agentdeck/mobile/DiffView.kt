package dev.agentdeck.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*

/** Every file the session touched, as a sheet over the conversation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChangesSheet(files: List<AgentFileChange>, loaded: Boolean, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface) {
        DiffView(files, loaded, Modifier.fillMaxWidth().heightIn(max = 560.dp))
    }
}

@Composable
internal fun DiffView(files: List<AgentFileChange>, loaded: Boolean, modifier: Modifier = Modifier) {
    val additions = files.sumOf { it.additions }
    val deletions = files.sumOf { it.deletions }
    var allExpanded by rememberSaveable { mutableStateOf(true) }
    var expandRevision by rememberSaveable { mutableStateOf(0) }
    Column(modifier.fillMaxWidth().background(Ink)) {
        Row(
            modifier = Modifier.fillMaxWidth().height(48.dp).background(Color(0xFF0C1014)).padding(start = 16.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Difference, null, tint = Muted, modifier = Modifier.size(17.dp))
            Spacer(Modifier.width(8.dp))
            // Claiming "0 files changed" while the fetch is still in flight
            // states a result the screen does not have yet. The body says it is
            // loading; this bar just holds the count until there is one.
            Text(
                if (!loaded && files.isEmpty()) "Changes" else "${plural(files.size, "file")} changed",
                color = Text.copy(alpha = 0.86f),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.weight(1f))
            if (additions > 0) Text("+$additions", color = Signal, fontFamily = FontFamily.Monospace, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            if (additions > 0 && deletions > 0) Spacer(Modifier.width(10.dp))
            if (deletions > 0) Text("−$deletions", color = Danger, fontFamily = FontFamily.Monospace, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            if (files.isNotEmpty()) {
                Spacer(Modifier.width(4.dp))
                IconButton(
                    onClick = {
                        allExpanded = !allExpanded
                        expandRevision += 1
                    },
                    modifier = Modifier.size(40.dp),
                ) {
                    Icon(
                        if (allExpanded) Icons.Rounded.UnfoldLess else Icons.Rounded.UnfoldMore,
                        if (allExpanded) "Collapse all files" else "Expand all files",
                        tint = Muted,
                        modifier = Modifier.size(19.dp),
                    )
                }
            }
        }
        if (files.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(horizontal = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(Icons.Rounded.Difference, null, tint = Muted, modifier = Modifier.size(32.dp))
                Spacer(Modifier.height(12.dp))
                // Until the session's changes have been fetched, "none" is not yet known.
                Text(if (loaded) "No captured changes" else "Loading changes…", fontWeight = FontWeight.SemiBold)
                if (loaded) {
                    Spacer(Modifier.height(6.dp))
                    Text("Edits and writes exposed by this runtime will appear here.", color = Muted, fontSize = 13.sp, lineHeight = 19.sp, textAlign = TextAlign.Center)
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(files, key = { "diff:${it.path}" }) { file ->
                    DiffFileCard(file, expandedByDefault = allExpanded, expandRevision = expandRevision)
                }
            }
        }
    }
}

@Composable
internal fun DiffFileCard(file: AgentFileChange, expandedByDefault: Boolean, expandRevision: Int) {
    var expanded by rememberSaveable(file.path, expandRevision) { mutableStateOf(expandedByDefault) }
    var showAllLines by rememberSaveable(file.path) { mutableStateOf(false) }
    val truncated = file.lineCount > DIFF_LINE_BUDGET && !showAllLines
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = Surface,
        border = BorderStroke(1.dp, Line),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(start = 12.dp, end = 8.dp, top = 11.dp, bottom = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.Description, null, tint = Blue, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(8.dp))
                // Start-ellipsis keeps the file name readable; the leading directories are the droppable part.
                Text(file.path, color = Text.copy(alpha = 0.9f), fontFamily = FontFamily.Monospace, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.StartEllipsis, modifier = Modifier.weight(1f))
                if (file.additions > 0) Text("+${file.additions}", color = Signal, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
                if (file.additions > 0 && file.deletions > 0) Spacer(Modifier.width(8.dp))
                if (file.deletions > 0) Text("−${file.deletions}", color = Danger, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
                Spacer(Modifier.width(5.dp))
                Icon(if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, if (expanded) "Collapse file" else "Expand file", tint = Muted, modifier = Modifier.size(18.dp))
            }
            if (expanded) {
                HorizontalDivider(color = Line)
                SelectionContainer {
                    BoxWithConstraints(Modifier.fillMaxWidth()) {
                        val viewportWidth = maxWidth
                        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                            // A horizontal scroller hands children infinite width, so fillMaxWidth() on a
                            // row is a no-op and each line's tint stops at its own text. Pinning the column
                            // to its widest line gives the rows a real width to fill, edge to edge.
                            Column(Modifier.widthIn(min = viewportWidth).width(IntrinsicSize.Max)) {
                                var rendered = 0
                                val budget = if (truncated) DIFF_LINE_BUDGET else Int.MAX_VALUE
                                file.hunks.forEachIndexed { index, hunk ->
                                    if (rendered >= budget) return@forEachIndexed
                                    if (index > 0) {
                                        Row(Modifier.fillMaxWidth().background(Blue.copy(alpha = 0.06f)).padding(horizontal = 10.dp, vertical = 5.dp)) {
                                            Text("Change ${index + 1} · ${formatMessageTime(hunk.createdAt)}", color = Blue, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
                                        }
                                    }
                                    for (line in hunk.lines) {
                                        if (rendered >= budget) break
                                        DiffLineRow(line, showLineNumbers = file.hasLineNumbers)
                                        rendered += 1
                                    }
                                }
                            }
                        }
                    }
                }
                if (file.lineCount > DIFF_LINE_BUDGET) {
                    HorizontalDivider(color = Line)
                    TextButton(
                        onClick = { showAllLines = !showAllLines },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
                    ) {
                        Text(
                            if (truncated) "Show all ${file.lineCount} lines" else "Show first $DIFF_LINE_BUDGET lines",
                            color = Blue,
                            fontSize = 12.sp,
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun DiffLineRow(line: AgentDiffLine, showLineNumbers: Boolean) {
    val background = when (line.kind) {
        DiffLineKind.Addition -> Signal.copy(alpha = 0.10f)
        DiffLineKind.Deletion -> Danger.copy(alpha = 0.10f)
        DiffLineKind.Header -> Blue.copy(alpha = 0.08f)
        DiffLineKind.Context -> Color.Transparent
    }
    val foreground = when (line.kind) {
        DiffLineKind.Addition -> Signal
        DiffLineKind.Deletion -> Danger
        DiffLineKind.Header -> Blue
        DiffLineKind.Context -> Text.copy(alpha = 0.78f)
    }
    val marker = when (line.kind) {
        DiffLineKind.Addition -> "+"
        DiffLineKind.Deletion -> "−"
        else -> " "
    }
    // Deletions are positioned in the old file, everything else in the new one.
    val lineNumber = if (line.kind == DiffLineKind.Deletion) line.oldLine else line.newLine
    Row(Modifier.fillMaxWidth().background(background).heightIn(min = 24.dp), verticalAlignment = Alignment.Top) {
        if (showLineNumbers) {
            Box(
                Modifier.width(40.dp).heightIn(min = 24.dp).padding(end = 6.dp),
                contentAlignment = Alignment.TopEnd,
            ) {
                Text(
                    lineNumber?.toString().orEmpty(),
                    color = Muted.copy(alpha = 0.55f),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    lineHeight = 20.sp,
                )
            }
        }
        Box(Modifier.width(24.dp).heightIn(min = 24.dp).background(foreground.copy(alpha = 0.08f)), contentAlignment = Alignment.TopCenter) {
            Text(marker, color = foreground, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 20.sp)
        }
        Text(
            if (line.kind == DiffLineKind.Header) hunkHeaderContext(line.text) ?: line.text else line.text.ifEmpty { " " },
            color = foreground,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            lineHeight = 20.sp,
            softWrap = false,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

/** Long file rewrites arrive as thousands of `+` lines; render a readable slice until asked for the rest. */
internal const val DIFF_LINE_BUDGET = 300
