package dev.agentdeck.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.agentdeck.shared.*

@Composable
internal fun ConnectionDialog(
    currentUrl: String,
    onDismiss: () -> Unit,
    onSave: (String, String, (Boolean, String?) -> Unit) -> Unit,
) {
    var url by remember { mutableStateOf(currentUrl) }
    var credential by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Rounded.Hub, null, tint = Signal) },
        title = { Text("Connect a bridge") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Use your machine's Tailscale IP or MagicDNS name, then enter the one-time code printed by the bridge.", color = Muted)
                OutlinedTextField(url, { url = it }, label = { Text("Bridge URL") }, singleLine = true, enabled = !working, shape = RoundedCornerShape(14.dp))
                OutlinedTextField(
                    credential,
                    { credential = it.filterNot(Char::isWhitespace); error = null },
                    label = { Text("Pairing code or token") },
                    // The raw-token route has always worked - six digits pairs,
                    // anything else is used as the token - and nothing said so.
                    // It is the one that does not expire, so it is worth naming.
                    supportingText = {
                        Text(error ?: "Six digits to pair, or paste a bridge token. Blank keeps this device's.")
                    },
                    isError = error != null,
                    singleLine = true,
                    enabled = !working,
                    shape = RoundedCornerShape(14.dp),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    working = true
                    error = null
                    onSave(url, credential) { success, message ->
                        working = false
                        if (!success) error = message
                    }
                },
                enabled = url.isNotBlank() && !working,
            ) {
                if (working) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text(if (credential.isBlank()) "Connect" else "Pair & connect")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = SurfaceRaised,
    )
}
