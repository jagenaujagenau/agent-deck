package dev.agentdeck.mobile

import dev.agentdeck.shared.SlashCommand
import org.junit.Assert.assertEquals
import org.junit.Test

class SlashCommandPickerTest {
    private val commands = listOf(
        SlashCommand("code-review", "Review the current diff for correctness bugs"),
        SlashCommand("diagnose", "Disciplined diagnosis loop for hard bugs"),
        SlashCommand("figma:figma-use", "Write actions in a Figma file"),
        SlashCommand("simplify", "Review changed code for reuse and simplification"),
    )

    @Test
    fun `a bare slash opens the picker on everything available`() {
        assertEquals("", slashCommandQuery("/"))
        assertEquals(commands, matchSlashCommands("", commands))
    }

    @Test
    fun `typing narrows the list as the command name is spelled out`() {
        assertEquals("diag", slashCommandQuery("/diag"))
        assertEquals(listOf("diagnose"), matchSlashCommands("diag", commands).map { it.name })
    }

    @Test
    fun `a name that starts with the query outranks one that merely contains it`() {
        val withContains = commands + SlashCommand("run-diagnose-suite", "Run it")
        assertEquals(
            listOf("diagnose", "run-diagnose-suite"),
            matchSlashCommands("diagnose", withContains).map { it.name },
        )
    }

    @Test
    fun `description matches are offered after name matches, so intent still finds a command`() {
        assertEquals(
            listOf("code-review", "simplify"),
            matchSlashCommands("review", commands).map { it.name },
        )
    }

    @Test
    fun `namespaced plugin commands are reachable by either half`() {
        assertEquals(listOf("figma:figma-use"), matchSlashCommands("figma", commands).map { it.name })
        assertEquals(listOf("figma:figma-use"), matchSlashCommands("figma-use", commands).map { it.name })
    }

    @Test
    fun `the picker closes once the message stops being a command token`() {
        // A space means the user has moved on to arguments or ordinary prose.
        assertEquals(null, slashCommandQuery("/diagnose the crash"))
        assertEquals(null, slashCommandQuery("no slash here"))
        assertEquals(null, slashCommandQuery("look at /tmp/file"))
        assertEquals(null, slashCommandQuery(""))
    }

    @Test
    fun `the list stays bounded so a long catalog cannot flood the sheet`() {
        val many = (1..80).map { SlashCommand("command-$it", "Number $it") }
        assertEquals(30, matchSlashCommands("command", many).size)
        assertEquals(5, matchSlashCommands("command", many, limit = 5).size)
    }
}
