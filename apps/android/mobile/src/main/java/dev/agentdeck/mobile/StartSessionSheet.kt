package dev.agentdeck.mobile

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*

/**
 * Start a bridge-hosted Claude session from the phone.
 *
 * The `cwd` is a path on the bridge's machine, not this one, so it is typed
 * rather than browsed: a person knows their own project roots, and the bridge
 * is the one that has to find the directory. The project names already on the
 * deck are offered as completions, because they are the work this bridge runs.
 */
@Composable
internal fun StartSessionSheet(
    projects: List<String>,
    workingDirectories: List<String>,
    starting: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onStart: (cwd: String, project: String, objective: String, prompt: String, permissionMode: String?, (Boolean, String?) -> Unit) -> Unit,
) {
    var project by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("") }
    var objective by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var permission by remember { mutableStateOf("default") }
    var fieldError by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!starting) onDismiss() },
        icon = { Icon(Icons.Rounded.PlayCircle, null, tint = Signal) },
        title = { Text("Start a session") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("The bridge runs this session itself, so it stays on when no terminal is watching.", color = Muted)
                OutlinedTextField(
                    value = project,
                    onValueChange = { project = it; fieldError = null },
                    label = { Text("Project") },
                    singleLine = true,
                    enabled = !starting,
                    shape = RoundedCornerShape(14.dp),
                )
                // The project names this bridge already serves, as quick fills.
                if (projects.isNotEmpty()) {
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        projects.take(8).forEach { name ->
                            AssistChip(
                                onClick = { if (!starting) project = name; fieldError = null },
                                label = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                shape = CircleShape,
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it; fieldError = null },
                    label = { Text("Working directory") },
                    placeholder = { Text("/absolute/path/on/the/bridge", color = Muted.copy(alpha = 0.6f)) },
                    singleLine = true,
                    enabled = !starting,
                    shape = RoundedCornerShape(14.dp),
                    supportingText = { Text("An absolute path on the bridge's machine.") },
                )
                // The directories the bridge has already run sessions in, most
                // recent first - tapping one fills the field, typing still works.
                if (workingDirectories.isNotEmpty()) {
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        workingDirectories.take(8).forEach { path ->
                            AssistChip(
                                onClick = { if (!starting) cwd = path; fieldError = null },
                                label = { Text(workingDirectoryLabel(path), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                shape = CircleShape,
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = objective,
                    onValueChange = { objective = it },
                    label = { Text("Objective") },
                    placeholder = { Text("What this session is for", color = Muted.copy(alpha = 0.6f)) },
                    singleLine = true,
                    enabled = !starting,
                    shape = RoundedCornerShape(14.dp),
                )
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    label = { Text("First message") },
                    placeholder = { Text("Sent the moment the session starts", color = Muted.copy(alpha = 0.6f)) },
                    enabled = !starting,
                    shape = RoundedCornerShape(14.dp),
                    minLines = 1,
                    maxLines = 4,
                )
                Text("Permission mode", fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp, color = Muted)
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ManagedPermission.entries.forEach { mode ->
                        FilterChip(
                            selected = permission == mode.wire,
                            onClick = { if (!starting) permission = mode.wire },
                            shape = CircleShape,
                            label = { Text(mode.label) },
                        )
                    }
                }
                if (fieldError != null || error != null) {
                    Text(fieldError ?: error ?: "", color = Danger, fontSize = 12.sp)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (project.isBlank() || cwd.isBlank()) {
                        fieldError = "A project and a working directory are required"
                        return@Button
                    }
                    if (!cwd.startsWith("/")) {
                        fieldError = "The working directory must be an absolute path"
                        return@Button
                    }
                    onStart(cwd, project, objective, prompt, permission) { success, message ->
                        if (!success) fieldError = message
                    }
                },
                enabled = !starting,
            ) {
                if (starting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text("Start")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !starting) { Text("Cancel") } },
        containerColor = SurfaceRaised,
    )
}

internal enum class ManagedPermission(val wire: String, val label: String) {
    Default("default", "Ask"),
    AcceptEdits("acceptEdits", "Auto-edit"),
    Plan("plan", "Plan"),
    Auto("auto", "Auto"),
}
