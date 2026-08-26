package dev.agentdeck.mobile

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.GenericShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.compose.material3.Text
import kotlin.math.roundToInt

/**
 * How fast the terminal types out a command it has just received.
 *
 * A rate rather than a duration, because a one-word command and a paragraph of
 * shell should feel like the same terminal working, not the same animation
 * stretched over different lengths.
 */
internal enum class TerminalTypeSpeed(val label: String, val charsPerSecond: Int) {
    Off("OFF", 0),
    Slow("SLOW", 30),
    Normal("NORM", 110),
    Fast("FAST", 320);

    /** Tapping the segment walks the list, so one control covers all four. */
    fun next(): TerminalTypeSpeed = entries[(ordinal + 1) % entries.size]
}

/** How long a line of this length takes at this rate, floored so it never divides by zero. */
internal fun typingDurationMs(length: Int, charsPerSecond: Int): Int =
    if (charsPerSecond <= 0 || length <= 0) 0 else (length * 1000 / charsPerSecond).coerceAtLeast(16)

/**
 * How much of a command has printed, as whole lines plus the one in progress.
 *
 * A terminal prints a line at a time. Typing straight through a multi-line
 * command instead reflows the whole block on every frame, so a wrapped command
 * grows like a paragraph being written rather than output arriving - which is
 * the opposite of the thing being imitated.
 */
internal data class TypedOutput(val lines: List<String>, val typing: Boolean)

/**
 * The command as far as it has printed.
 *
 * Only what arrived after this screen opened is animated. Replaying a
 * session's whole scrollback every time it recomposes would be unreadable, and
 * would re-type the same line each time the list scrolled it back into view.
 */
@Composable
internal fun typedOutput(text: String, animate: Boolean, speed: TerminalTypeSpeed): TypedOutput {
    val all = remember(text) { text.lines() }
    if (!animate || speed.charsPerSecond <= 0 || text.isEmpty()) return TypedOutput(all, typing = false)
    val progress = remember(text, speed) { Animatable(0f) }
    LaunchedEffect(text, speed) {
        progress.snapTo(0f)
        progress.animateTo(
            targetValue = 1f,
            animationSpec = tween(typingDurationMs(text.length, speed.charsPerSecond), easing = LinearEasing),
        )
    }
    // Character count across the whole command, then spent line by line, so a
    // long line takes proportionally longer than a short one - which is what
    // makes the rate read as one terminal working rather than each line
    // getting an equal slice regardless of length.
    var budget = (text.length * progress.value).roundToInt()
    val shown = mutableListOf<String>()
    for (line in all) {
        if (budget <= 0) break
        if (budget >= line.length) {
            shown += line
            // The newline costs a character too, which is what paces the gap
            // between one line finishing and the next starting.
            budget -= line.length + 1
        } else {
            shown += line.take(budget)
            budget = 0
            break
        }
    }
    val done = shown.size == all.size && shown.lastOrNull() == all.lastOrNull()
    return TypedOutput(if (shown.isEmpty()) listOf("") else shown, typing = !done)
}

/**
 * A block caret that blinks the way a terminal's does.
 *
 * Square, not a fade: a cursor is on or it is off, and easing it makes the
 * terminal look like a web page pretending to be one.
 */
@Composable
internal fun BlinkingCaret(
    color: Color,
    modifier: Modifier = Modifier,
    width: Dp = 9.dp,
    height: Dp = 17.dp,
) {
    val blink = rememberInfiniteTransition(label = "caret")
    val phase by blink.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1060, easing = LinearEasing), RepeatMode.Restart),
        label = "caret-phase",
    )
    Box(
        modifier
            .size(width, height)
            .background(if (phase < 0.5f) color else Color.Transparent),
    )
}

/** The angled edge a powerline segment ends in, drawn rather than borrowed from a patched font. */
private fun powerlineShape(arrowPx: Float) = GenericShape { size, _ ->
    moveTo(0f, 0f)
    lineTo(size.width - arrowPx, 0f)
    lineTo(size.width, size.height / 2f)
    lineTo(size.width - arrowPx, size.height)
    lineTo(0f, size.height)
    close()
}

/**
 * One segment of the status line.
 *
 * The chevron is a shape because the glyph that normally draws it (U+E0B0)
 * exists only in patched fonts, and a device without one renders a hollow box
 * across the whole bar.
 */
@Composable
internal fun PowerlineSegment(
    text: String,
    background: Color,
    foreground: Color,
    modifier: Modifier = Modifier,
    arrow: Dp = 9.dp,
    onClick: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
) {
    val arrowPx = with(LocalDensity.current) { arrow.toPx() }
    val shape = remember(arrowPx) { powerlineShape(arrowPx) }
    Row(
        modifier
            .height(24.dp)
            .clip(shape)
            .background(background)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            // Room on the right for the chevron, so the text does not run into it.
            .padding(start = 10.dp, end = arrow + 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading?.let {
            it()
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text,
            color = foreground,
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp,
        )
    }
}

/**
 * The status line under the scrollback.
 *
 * Segments overlap by the width of their chevron and are stacked so each one's
 * point sits over the segment after it, which is what makes the row read as a
 * single ribbon rather than a row of arrows.
 */
@Composable
internal fun PowerlineBar(
    segments: List<PowerlineCell>,
    modifier: Modifier = Modifier,
    arrow: Dp = 9.dp,
) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        segments.forEachIndexed { index, cell ->
            PowerlineSegment(
                text = cell.text,
                background = cell.background,
                foreground = cell.foreground,
                arrow = arrow,
                onClick = cell.onClick,
                modifier = Modifier
                    .zIndex((segments.size - index).toFloat())
                    .then(if (index == 0) Modifier else Modifier.padding(start = 0.dp))
                    .absoluteOffset(x = if (index == 0) 0.dp else -arrow),
            )
        }
    }
}

internal data class PowerlineCell(
    val text: String,
    val background: Color,
    val foreground: Color,
    val onClick: (() -> Unit)? = null,
)

/**
 * What a terminal line should actually show.
 *
 * A heredoc that writes a file arrives as the whole file: measured on this
 * bridge, `cat > … <<'EOF'` commands are eight thousand characters, clipped.
 * Printing that is not showing the command, it is burying the session in the
 * file's own contents - and the one fact worth reading, which file was
 * written, is on the first line and then lost.
 */
internal sealed interface TerminalLine {
    /**
     * An ordinary command.
     *
     * `hiddenLines` is the heredoc body that follows it. Measured on one real
     * session: 955 commands carried a heredoc, and between them 41,187 lines
     * of payload. Printing those is not showing the session's commands, it is
     * showing the files and scripts they happened to carry - so the command is
     * kept and its input is counted.
     */
    data class Shell(val text: String, val hiddenLines: Int = 0) : TerminalLine

    /** A write to a file, shown as the act rather than the payload. */
    data class FileWrite(val verb: String, val path: String) : TerminalLine {
        val name: String get() = path.substringAfterLast('/').ifEmpty { path }
        /** The directory, trimmed to something that fits a phone. */
        val parent: String
            get() = path.substringBeforeLast('/', "").let { dir ->
                if (dir.length <= 34) dir else "…" + dir.takeLast(33)
            }
    }
}

// `cat > path`, `cat >> path` - the redirect carries whether it replaces or appends.
private val CAT_WRITE = Regex("""\bcat\s*(>>|>)\s*("[^"]+"|'[^']+'|[^\s<>|;&]+)""")

// `tee path`, `tee -a path` - the flag carries it instead.
private val TEE_WRITE = Regex("""\btee\s+(-a\s+)?("[^"]+"|'[^']+'|[^\s<>|;&]+)""")

private fun unquote(value: String) = value.trim('"', '\'')

/**
 * Whether this looks like a path worth naming rather than a stream.
 *
 * `/dev/null` and `/dev/stdout` are redirections, not edits, and calling them
 * an edit would be the same overclaiming this is meant to remove.
 */
private fun isFilePath(value: String): Boolean =
    value.isNotBlank() && !value.startsWith("/dev/") && (value.contains('/') || value.contains('.'))

/** How a command should be drawn: as itself, or as the file it writes. */
internal fun terminalLine(command: String): TerminalLine {
    val lines = command.lines()
    // The heredoc opener is not always on the first line - a command that cds
    // first and then pipes a script puts it on the second, which is the common
    // shape here. Everything up to and including that line is the command;
    // everything after it is what the command was fed.
    val opener = lines.indexOfFirst { HEREDOC.containsMatchIn(it) }
    val head = if (opener >= 0) lines.take(opener + 1).joinToString("\n") else command

    CAT_WRITE.find(head)?.let { match ->
        val path = unquote(match.groupValues[2])
        if (isFilePath(path)) {
            return TerminalLine.FileWrite(
                verb = if (match.groupValues[1] == ">>") "Appending to" else "Editing",
                path = path,
            )
        }
    }
    TEE_WRITE.find(head)?.let { match ->
        val path = unquote(match.groupValues[2])
        if (isFilePath(path)) {
            return TerminalLine.FileWrite(
                verb = if (match.groupValues[1].isNotBlank()) "Appending to" else "Editing",
                path = path,
            )
        }
    }

    // Anything else with a heredoc keeps its command and drops the body. What a
    // script writes is not worth guessing at - a piped python could do anything
    // - but the fact that it carried input is worth saying.
    if (opener >= 0 && lines.size > opener + 1) {
        return TerminalLine.Shell(head, hiddenLines = lines.size - opener - 1)
    }
    return TerminalLine.Shell(command)
}

/** The shapes bash accepts for a heredoc tag. */
private val HEREDOC = Regex("<<-?\\s*[\"']?[A-Za-z_][A-Za-z0-9_]*[\"']?")
