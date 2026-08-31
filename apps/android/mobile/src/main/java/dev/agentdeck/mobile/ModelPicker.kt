package dev.agentdeck.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.RuntimeModel

/**
 * Which model this session answers as.
 *
 * The list is the runtime's own — asked of it, never compiled into the app —
 * so a model that shipped this morning is here this morning, and a model this
 * account cannot reach is not here at all. Only a bridge-hosted session has
 * one: a session running in somebody's terminal answers as whatever that
 * terminal told it to, and the sheet says so rather than offering a control
 * that would do nothing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ModelPicker(
    models: List<RuntimeModel>,
    current: String,
    onPick: (RuntimeModel) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 28.dp)) {
            Text("Model", color = Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(3.dp))
            Text(
                if (models.isEmpty()) {
                    "This session's model belongs to the runtime running it."
                } else {
                    "What this session answers as, from the runtime's own list."
                },
                color = Muted,
                fontSize = 13.sp,
                lineHeight = 18.sp,
            )
            Spacer(Modifier.height(12.dp))
            LazyColumn(
                modifier = Modifier.weight(1f, fill = false),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                items(models, key = { it.id }) { model ->
                    // The running model is matched by id or by what an alias
                    // resolves to, so a session started on an explicit id still
                    // shows its alias row as the one it is on.
                    val selected = model.id == current || model.resolvedModel == current
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (selected) Signal.copy(alpha = 0.10f) else Surface)
                            .clickable { onPick(model) }
                            .padding(horizontal = 12.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                model.label,
                                color = if (selected) Signal else Text,
                                fontSize = 14.sp,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            model.description?.takeIf { it.isNotBlank() }?.let {
                                Text(
                                    it,
                                    color = Muted,
                                    fontSize = 12.sp,
                                    lineHeight = 16.sp,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        if (selected) {
                            Spacer(Modifier.width(8.dp))
                            Icon(Icons.Rounded.Check, "Current model", tint = Signal, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
        }
    }
}
