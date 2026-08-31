package dev.agentdeck.mobile

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*
import dev.agentdeck.shared.Harness
import dev.agentdeck.shared.Harnesses

/**
 * A runtime, with its own mark where one exists.
 *
 * `icon` points at the vendor's actual artwork, shared with the home screen
 * widget and the watch tile so all three draw the same thing. Pi ships no mark,
 * so its initial stands in - and the field is null rather than a placeholder
 * precisely so the drawing code can tell the difference.
 */
internal enum class AgentHarness(val label: String, val color: Color, val icon: Int?) {
    Pi("Pi", Blue, null),
    Claude("Claude Code", Color(0xFFD97757), dev.agentdeck.shared.R.drawable.harness_claude),
    Codex("Codex", Text, dev.agentdeck.shared.R.drawable.harness_codex),
    OpenCode("OpenCode", Signal, dev.agentdeck.shared.R.drawable.harness_opencode),
    Gemini("Gemini CLI", Color(0xFF78A7FF), null),
    Managed("Managed Claude", Color(0xFFD97757), dev.agentdeck.shared.R.drawable.harness_claude),
    Other("Agent", Muted, null),
}

internal data class ProviderIdentity(val name: String, val model: String, val color: Color)

/**
 * Which runtime a session belongs to, decided once for the whole product.
 *
 * Reading the display name missed OpenCode entirely - its sessions showed as
 * "Agent" on the phone while the widget named them correctly, because the
 * widget asked the shared derivation and this did not.
 */
internal fun harnessFor(agent: Agent) = when (Harnesses.of(agent)) {
    Harness.Pi -> AgentHarness.Pi
    Harness.Claude -> AgentHarness.Claude
    Harness.Codex -> AgentHarness.Codex
    Harness.OpenCode -> AgentHarness.OpenCode
    Harness.Gemini -> AgentHarness.Gemini
    Harness.Managed -> AgentHarness.Managed
    Harness.Unknown -> AgentHarness.Other
}

internal fun providerFor(agent: Agent): ProviderIdentity {
    val raw = agent.model.substringAfterLast('/').trim()
    val provider = when {
        agent.model.contains("claude", true) || agent.model.equals("Claude Code", true) -> Triple("Anthropic", Color(0xFFD97757), "Anthropic")
        agent.model.contains("gemini", true) -> Triple("Google", Color(0xFF78A7FF), "Google")
        agent.model.contains("grok", true) -> Triple("xAI", Text, "xAI")
        agent.model.contains("gpt", true) || agent.model.contains("openai", true) || harnessFor(agent) == AgentHarness.Codex -> Triple("OpenAI", Signal, "OpenAI")
        else -> Triple("Provider", Muted, "Model unavailable")
    }
    val model = when {
        raw.equals("Claude Code", true) -> provider.third
        raw.startsWith("claude-", true) -> humanizeModelId(raw.removePrefix("claude-"))
        raw.startsWith("gpt-", true) -> "GPT-${humanizeModelId(raw.removePrefix("gpt-"))}"
        raw.isBlank() -> provider.third
        else -> raw
    }
    return ProviderIdentity(provider.first, model, provider.second)
}

@Composable
internal fun HarnessMark(harness: AgentHarness, running: Boolean, statusColor: Color, diameter: Dp = 50.dp) {
    Box(Modifier.size(diameter), contentAlignment = Alignment.Center) {
        Box(Modifier.size(diameter * 0.82f)) {
            Surface(
                shape = CircleShape,
                // Neutral, not tinted by the harness: a white mark on its own
                // pale halo is invisible, and the widget's badge is this colour.
                color = SurfaceSunken,
                modifier = Modifier.fillMaxSize(),
            ) {
                Box(contentAlignment = Alignment.Center) { AgentLogo(harness, Modifier.size(diameter * 0.58f)) }
            }
            if (running) {
                CircularProgressIndicator(
                    modifier = Modifier.fillMaxSize(),
                    color = statusColor.copy(alpha = 0.78f),
                    trackColor = Line,
                    strokeWidth = 2.5.dp,
                )
            } else {
                Box(
                    Modifier.align(Alignment.BottomEnd).offset(x = 1.5.dp, y = 1.5.dp)
                        .size(11.dp).clip(CircleShape).background(Ink).padding(2.dp)
                        .clip(CircleShape).background(statusColor),
                )
            }
        }
    }
}

@Composable
internal fun AgentLogo(harness: AgentHarness, modifier: Modifier = Modifier) {
    val icon = harness.icon
    if (icon != null) {
        // The vendor's own artwork rather than an approximation of it. This used
        // to draw eight radiating lines for Claude and six circles for Codex -
        // close enough to recognise, not close enough to be the mark.
        Image(painterResource(icon), harness.label, modifier)
    } else {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text(
                if (harness == AgentHarness.Pi) "π" else "··",
                color = harness.color,
                fontSize = 16.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.SemiBold,
                style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false)),
            )
        }
    }
}

@Composable
internal fun ProviderMark(provider: ProviderIdentity, diameter: androidx.compose.ui.unit.Dp = 20.dp) {
    Surface(shape = CircleShape, color = provider.color.copy(alpha = 0.13f), modifier = Modifier.size(diameter)) {
        Box(contentAlignment = Alignment.Center) {
            if (provider.name == "OpenAI") Canvas(Modifier.size(diameter * 0.6f)) {
                drawCircle(provider.color, radius = size.minDimension * 0.38f, style = Stroke(width = size.minDimension * 0.16f))
                drawCircle(provider.color, radius = size.minDimension * 0.1f)
            } else Text(provider.name.take(1), color = provider.color, fontSize = (diameter.value * 0.45f).sp, lineHeight = (diameter.value * 0.45f).sp, fontWeight = FontWeight.Bold, modifier = Modifier.offset(y = (-0.5).dp), style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false)))
        }
    }
}
