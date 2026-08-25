package dev.agentdeck.wear

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Text

/**
 * Dictating or typing a reply from the wrist.
 *
 * Wear's own input activity is what collects this: it offers voice, the
 * keyboard and canned replies behind one intent, and the transcription happens
 * on the watch. Bringing a recogniser of our own would mean shipping audio
 * somewhere to say what this already does locally.
 */
private const val REPLY_KEY = "agent_deck_reply"

@Composable
internal fun WatchComposer(
    label: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onMessage: (String) -> Unit,
) {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val data = result.data ?: return@rememberLauncherForActivityResult
        val spoken = RemoteInput.getResultsFromIntent(data)?.getCharSequence(REPLY_KEY)?.toString()
        val text = spoken?.trim().orEmpty()
        if (text.isNotEmpty()) onMessage(text)
    }

    Button(
        onClick = { launcher.launch(replyIntent(label)) },
        enabled = enabled,
        modifier = modifier.fillMaxWidth(),
    ) {
        Text(label, fontSize = 13.sp)
    }
    Spacer(Modifier.height(2.dp))
}

/**
 * The intent Wear opens for a reply. `setAllowFreeFormInput` is what puts voice
 * and the keyboard on the picker rather than only the canned choices.
 */
private fun replyIntent(label: String): Intent {
    val remoteInput = RemoteInput.Builder(REPLY_KEY)
        .setLabel(label)
        .setAllowFreeFormInput(true)
        .build()
    val intent = Intent(REMOTE_INPUT_ACTION)
    intent.putExtra(REMOTE_INPUT_EXTRA, arrayOf(remoteInput))
    return intent
}

private const val REMOTE_INPUT_ACTION = "android.support.wearable.input.action.REMOTE_INPUT"
private const val REMOTE_INPUT_EXTRA = "android.support.wearable.input.extra.REMOTE_INPUTS"
