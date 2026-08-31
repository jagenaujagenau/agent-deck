package dev.agentdeck.mobile

import androidx.compose.ui.graphics.Color

/**
 * The deck's one dark world, named once.
 *
 * Every screen file imports these rather than declaring its own; the widget
 * and the watch keep their own palettes because they paint on surfaces this
 * app does not own.
 */
internal val Ink = Color(0xFF090C10)
internal val Surface = Color(0xFF11161C)
internal val SurfaceRaised = Color(0xFF181E25)
internal val SurfaceSunken = Color(0xFF0E1319)
internal val Line = Color(0xFF252D36)
internal val Text = Color(0xFFF2F5F7)
internal val Muted = Color(0xFF8D99A6)
internal val Signal = Color(0xFF83E6B2)
internal val Amber = Color(0xFFFFC266)
internal val Danger = Color(0xFFFF7B7B)
internal val Blue = Color(0xFF8CB7FF)
