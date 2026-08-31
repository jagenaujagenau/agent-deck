package dev.agentdeck.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*

@Composable
internal fun MessageComposer(agent: Agent, busy: Boolean, commandError: String?, commandNotice: String?, commandBlocked: BlockedCommand?, onSendAnyway: () -> Unit, supports: (String) -> Boolean, slashCommands: List<SlashCommand>, onControl: (String, String?) -> Unit, autoFocus: Boolean, lensed: Boolean = false, queuedMessages: List<QueuedCommand> = emptyList(), onCancelQueued: (String) -> Unit = {}) {
    var message by rememberSaveable(agent.id) { mutableStateOf("") }
    // A refused message is not a sent one: the words come back into the field
    // so the draft survives the refusal, exactly as typed.
    LaunchedEffect(commandBlocked) {
        if (commandBlocked != null && message.isBlank()) message = commandBlocked.value.orEmpty()
    }
    val composerFocus = remember { FocusRequester() }
    // Switching to a view that can be typed into means wanting to type into it.
    // Arriving at the session does not - so this waits for a deliberate tab
    // choice rather than firing on first composition. Guarded because the node
    // is not attached on the first frame, and a focus request against nothing
    // throws rather than waiting.
    LaunchedEffect(Unit) { if (autoFocus) runCatching { composerFocus.requestFocus() } }
    val action = remoteMessageAction(agent.state, supports)
    if (action == null) {
        Text("This runtime does not accept remote messages.", color = Muted, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().padding(16.dp))
        return
    }
    val query = slashCommandQuery(message)
    val matches = remember(query, slashCommands) { query?.let { matchSlashCommands(it, slashCommands) }.orEmpty() }
    // Floating: no bar across the bottom. The composer sits on the conversation
    // with air around it, so the chat reads as continuing underneath rather than
    // stopping at a wall.
    Box(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 10.dp, vertical = 8.dp)) {
            if (matches.isNotEmpty()) SlashCommandPicker(matches) { message = "/${it.name} " }
            else if (query != null && slashCommands.isEmpty()) {
                Text("No commands reported by this runtime.", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp))
            }
            // Over the conversation now, so each notice carries its own ground.
            commandBlocked?.let { BlockedSendNotice(it.detail, onSendAnyway) }
            if (commandBlocked == null) commandError?.let { FloatingNotice(it, Danger) }
            // The dock says "queued" better than the notice does, and adds the
            // taking-back; the notice only speaks when the dock has nothing.
            if (commandBlocked == null && commandError == null && queuedMessages.isEmpty()) {
                commandNotice?.let { FloatingNotice(it, Muted) }
            }
            if (queuedMessages.isNotEmpty()) {
                QueuedMessageDock(
                    queuedMessages,
                    onEdit = { queuedCommand ->
                        onCancelQueued(queuedCommand.id)
                        message = queuedCommand.value.orEmpty()
                    },
                    onCancel = { onCancelQueued(it.id) },
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom,
            ) {
            // One rounded field, the way every messaging app draws one. The
            // outlined variant put a visible box inside a raised bar - two
            // borders around the same thing - and the slash button lives inside
            // it because it acts on what is being typed, not on the session.
            // One pill holding everything, the way a messaging composer is
            // drawn: the button belongs to the field it acts on, not beside it.
            ComposerPill(
                modifier = Modifier.weight(1f),
                leading = {
                    IconButton(
                        onClick = { message = if (message.startsWith("/")) message else "/$message" },
                        modifier = Modifier.size(40.dp),
                    ) {
                        Icon(
                            Icons.Rounded.Bolt,
                            "Slash command",
                            tint = if (message.startsWith("/")) Signal else Muted,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
                field = {
                    // BasicTextField, not TextField: the material one carries a
                    // 56dp minimum of its own, which made the pill taller than
                    // whatever sat next to it. Here the padding is the height.
                    ComposerField(
                        value = message,
                        onValueChange = { message = it },
                        placeholder = when {
                            // Under a lens the field is still the session's.
                            lensed -> "Message the session…"
                            action == "steer" -> "Reply or steer…  / commands  ! shell"
                            else -> "Message agent…  / commands  ! shell"
                        },
                        modifier = Modifier.weight(1f),
                        focusRequester = composerFocus,
                    )
                },
                action = {
                    ComposerSendButton(
                        hasText = message.isNotBlank(),
                        busy = busy,
                        onSend = {
                            // What a draft becomes is one shared rule — see
                            // `composerSubmission`; nothing to send sends nothing.
                            composerSubmission(message)?.let { onControl(action, it) }
                            message = ""
                        },
                    )
                },
            )
        }
    }
}
}

/**
 * What was said before the runtime was ready to hear it, held where it can
 * still be taken back. Each row is one queued instruction: the pencil pulls
 * its words back into the composer (withdrawing the original), the cross
 * withdraws it outright. Once the runtime collects a message its row
 * disappears — a delivered instruction cannot be unsaid, only followed up.
 */
@Composable
internal fun QueuedMessageDock(
    queued: List<QueuedCommand>,
    onEdit: (QueuedCommand) -> Unit,
    onCancel: (QueuedCommand) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(Surface)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        queued.forEach { command ->
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Schedule, null, tint = Muted, modifier = Modifier.size(13.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    command.value.orEmpty().ifBlank { command.action },
                    color = Text.copy(alpha = 0.85f),
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { onEdit(command) }, modifier = Modifier.size(30.dp)) {
                    Icon(Icons.Rounded.Edit, "Edit queued message", tint = Muted, modifier = Modifier.size(14.dp))
                }
                IconButton(onClick = { onCancel(command) }, modifier = Modifier.size(30.dp)) {
                    Icon(Icons.Rounded.Close, "Cancel queued message", tint = Muted, modifier = Modifier.size(14.dp))
                }
            }
        }
    }
}

@Composable
internal fun SlashCommandPicker(matches: List<SlashCommand>, onPick: (SlashCommand) -> Unit) {
    // Capped so the sheet never swallows the conversation; the list scrolls beyond that.
    LazyColumn(
        modifier = Modifier.fillMaxWidth().heightIn(max = 224.dp).padding(bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        items(matches, key = { it.name }) { command ->
            Surface(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { onPick(command) },
                color = Color.Transparent,
            ) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("/${command.name}", color = Blue, fontFamily = FontFamily.Monospace, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        command.description?.takeIf(String::isNotBlank)?.let {
                            Text(it, color = Muted, fontSize = 11.sp, lineHeight = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (command.source != "user") {
                        Spacer(Modifier.width(8.dp))
                        Text(command.source, color = Muted.copy(alpha = 0.7f), fontSize = 9.sp)
                    }
                }
            }
        }
    }
}

/**
 * The composer: a leading mark, the field, and the button that acts on it, all
 * in one rounded container.
 *
 * The button used to sit outside, which made it look like a separate control
 * that happened to be nearby. Inside, it reads as belonging to the text it
 * sends - and the pill is the only thing that has to be sized, because
 * everything within it is measured against the same height.
 */
@Composable
internal fun ComposerPill(
    modifier: Modifier = Modifier,
    leading: @Composable RowScope.() -> Unit,
    field: @Composable RowScope.() -> Unit,
    action: @Composable RowScope.() -> Unit,
) {
    Surface(
        modifier = modifier.heightIn(min = 52.dp).shadow(8.dp, CircleShape),
        shape = CircleShape,
        color = SurfaceRaised,
        border = BorderStroke(1.dp, Line),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(end = 5.dp),
        ) {
            leading()
            field()
            action()
        }
    }
}

/**
 * Send.
 *
 * It briefly held to dictate as well, which was a mistake: every Android
 * keyboard already carries a microphone, and a second one inside the app is a
 * worse copy of it that also wants a permission.
 */
@Composable
internal fun ComposerSendButton(hasText: Boolean, busy: Boolean, onSend: () -> Unit) {
    FilledIconButton(
        onClick = onSend,
        enabled = hasText && !busy,
        modifier = Modifier.size(42.dp),
        shape = CircleShape,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        else Icon(Icons.Rounded.ArrowUpward, "Send", modifier = Modifier.size(20.dp))
    }
}

/**
 * The text field inside a composer pill.
 *
 * Material's `TextField` reserves 56dp for a label it is never given, so a pill
 * built around one is always taller than the button beside it no matter what
 * height either is asked for. This sets its own padding, which makes the pill
 * and the send button the same size because both are told the same number.
 */
@Composable
internal fun ComposerField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    monospace: Boolean = false,
    focusRequester: FocusRequester? = null,
) {
    val style = TextStyle(
        color = Text,
        fontSize = if (monospace) 14.sp else 15.sp,
        lineHeight = 20.sp,
        fontFamily = if (monospace) FontFamily.Monospace else null,
    )
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .then(focusRequester?.let { Modifier.focusRequester(it) } ?: Modifier)
            .padding(horizontal = 8.dp, vertical = 13.dp),
        textStyle = style,
        maxLines = 4,
        cursorBrush = SolidColor(Signal),
        decorationBox = { inner ->
            if (value.isEmpty()) Text(placeholder, color = Muted, style = style)
            inner()
        },
    )
}

/** A line above the composer, legible over whatever the conversation put behind it. */
@Composable
internal fun FloatingNotice(text: String, tint: Color) {
    Surface(
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 3.dp),
        shape = RoundedCornerShape(10.dp),
        color = SurfaceRaised,
        border = BorderStroke(1.dp, Line),
    ) {
        Text(
            text,
            color = tint,
            fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

/**
 * The bridge's refusal to message a blocked session, in the session's own amber.
 *
 * It carries the bridge's sentence about what is pending, points at the
 * approval or question card that owns the block, and offers the one explicit
 * way past it. The refused words are already back in the field below.
 */
@Composable
internal fun BlockedSendNotice(detail: String, onSendAnyway: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 3.dp),
        shape = RoundedCornerShape(14.dp),
        color = Amber.copy(alpha = 0.10f),
        border = BorderStroke(1.dp, Amber.copy(alpha = 0.24f)),
    ) {
        Column(Modifier.padding(start = 12.dp, end = 6.dp, top = 8.dp, bottom = 2.dp)) {
            Text(detail, color = Amber, fontSize = 12.sp, lineHeight = 17.sp)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Answer the pending card above first.",
                    color = Muted,
                    fontSize = 11.sp,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onSendAnyway) { Text("Send anyway", fontSize = 12.sp) }
            }
        }
    }
}

@Composable
internal fun TerminalCommandComposer(
    agent: Agent,
    busy: Boolean,
    commandError: String?,
    commandNotice: String?,
    commandBlocked: BlockedCommand?,
    onSendAnyway: () -> Unit,
    supports: (String) -> Boolean,
    onControl: (String, String?) -> Unit,
) {
    val action = remoteMessageAction(agent.state, supports) ?: return
    var command by rememberSaveable(agent.id) { mutableStateOf("") }
    val composerFocus = remember { FocusRequester() }

    // Not a pill. A terminal's prompt is a line at the bottom of the window,
    // flush with the scrollback above it - a floating rounded field inside a
    // terminal window is a chat box wearing a monospace font.
    var focused by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding()) {
        // The refused instruction rides in commandBlocked and "Send anyway"
        // resends it verbatim, so the prompt line itself stays untouched.
        commandBlocked?.let { BlockedSendNotice(it.detail, onSendAnyway) }
        if (commandBlocked == null) commandError?.let { FloatingNotice(it, Danger) }
        if (commandBlocked == null && commandError == null) commandNotice?.let { FloatingNotice(it, Muted) }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF080B0E))
                .padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "\$",
                color = Signal,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
            )
            Spacer(Modifier.width(10.dp))
            Box(Modifier.weight(1f).onFocusChanged { focused = it.isFocused }) {
                ComposerField(
                    value = command,
                    onValueChange = { command = it },
                    placeholder = "",
                    monospace = true,
                    focusRequester = composerFocus,
                )
                // The caret only stands in while the field is not focused; once
                // it is, the text field draws a real one, and two cursors on a
                // prompt is worse than none. It rests where an empty prompt's
                // cursor rests — at the start, right after the $.
                if (!focused && command.isEmpty()) {
                    BlinkingCaret(Signal, Modifier.align(Alignment.CenterStart))
                }
            }
            ComposerSendButton(
                hasText = command.isNotBlank(),
                busy = busy,
                onSend = {
                    onControl(action, terminalCommandInstruction(command.trim()))
                    command = ""
                },
            )
        }
    }
}
