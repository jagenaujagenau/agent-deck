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
 * The text as far as it has been typed.
 *
 * Only what arrived after this screen opened is animated. Replaying a session's
 * whole scrollback every time it recomposes would be unreadable, and would
 * re-type the same line each time the list scrolled it back into view.
 */
@Composable
internal fun typedText(text: String, animate: Boolean, speed: TerminalTypeSpeed): String {
    if (!animate || speed.charsPerSecond <= 0 || text.isEmpty()) return text
    val progress = remember(text, speed) { Animatable(0f) }
    LaunchedEffect(text, speed) {
        progress.snapTo(0f)
        progress.animateTo(
            targetValue = 1f,
            animationSpec = tween(typingDurationMs(text.length, speed.charsPerSecond), easing = LinearEasing),
        )
    }
    return text.take((text.length * progress.value).roundToInt())
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
