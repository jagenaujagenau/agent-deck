package dev.agentdeck.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalLineTest {
    private fun write(command: String) = terminalLine(command) as TerminalLine.FileWrite

    @Test
    fun `a heredoc write is the act, not the file it carries`() {
        // Captured shape: on this bridge these run to 8000 characters.
        val command = "cat > /Users/d/code/app/MainActivity.kt <<'EOF'\n" + "x".repeat(8000) + "\nEOF"
        val line = write(command)
        assertEquals("Editing", line.verb)
        assertEquals("MainActivity.kt", line.name)
    }

    @Test
    fun `appending is not the same as replacing`() {
        assertEquals("Appending to", write("cat >> notes/log.md <<'EOF'").verb)
        assertEquals("Editing", write("cat > notes/log.md <<'EOF'").verb)
    }

    @Test
    fun `tee carries it in the flag instead of the redirect`() {
        assertEquals("Editing", write("tee /etc/hosts").verb)
        assertEquals("Appending to", write("tee -a /etc/hosts").verb)
    }

    @Test
    fun `a quoted path with spaces survives`() {
        assertEquals("My Notes.md", write("cat > \"/Users/d/My Notes.md\" <<'EOF'").name)
    }

    @Test
    fun `a redirection to a stream is not an edit`() {
        // Calling /dev/null an edit is the same overclaiming this removes.
        assertTrue(terminalLine("cat > /dev/null") is TerminalLine.Shell)
    }

    @Test
    fun `an ordinary command is left exactly as typed`() {
        val command = "grep -rn 'powerline' apps/android --include='*.kt'"
        assertEquals(command, (terminalLine(command) as TerminalLine.Shell).text)
    }

    @Test
    fun `a cat that reads is not a write`() {
        assertTrue(terminalLine("cat apps/android/README.md") is TerminalLine.Shell)
    }

    @Test
    fun `a long directory is trimmed from the left, keeping the end`() {
        // The end of a path is the part that identifies it; the start is
        // boilerplate that is the same for every file in the repo.
        val line = write("cat > /Users/d/tmp/code/personal/vibecoding/agent-control-dashboard/apps/x.kt <<'EOF'")
        assertTrue(line.parent.startsWith("…"))
        assertTrue(line.parent.endsWith("/apps"))
        assertEquals("x.kt", line.name)
    }
}

class TerminalHeredocTest {
    @Test
    fun `a script heredoc keeps its command and counts its body`() {
        // 955 of these in one real session, carrying 41,187 lines between them.
        val command = "python3 - <<'PY'\n" + (1..40).joinToString("\n") { "line $it" } + "\nPY"
        val line = terminalLine(command) as TerminalLine.Shell
        assertEquals("python3 - <<'PY'", line.text)
        assertEquals(41, line.hiddenLines)
    }

    @Test
    fun `a command with no heredoc keeps every line it has`() {
        // Multi-line without a heredoc is the command itself, not payload.
        val command = "git commit -F - \\\n  --author x"
        val line = terminalLine(command) as TerminalLine.Shell
        assertEquals(command, line.text)
        assertEquals(0, line.hiddenLines)
    }

    @Test
    fun `a cat write still wins over the heredoc rule`() {
        val line = terminalLine("cat > src/Main.kt <<'EOF'\nbody\nEOF")
        assertTrue(line is TerminalLine.FileWrite)
    }
}

class TerminalHeredocOffsetTest {
    @Test
    fun `a heredoc opened on a later line is still a heredoc`() {
        // The shape that slipped through: cd first, script second. Caught by
        // looking at the rendered terminal, not by the tests I had written.
        val command = "cd /Users/d/code/repo\npython3 <<'OUTER'\nbody one\nbody two\nOUTER"
        val line = terminalLine(command) as TerminalLine.Shell
        assertEquals("cd /Users/d/code/repo\npython3 <<'OUTER'", line.text)
        assertEquals(3, line.hiddenLines)
    }

    @Test
    fun `a cat write on a later line is still a write`() {
        val line = terminalLine("cd /repo\ncat > src/Main.kt <<'EOF'\nbody\nEOF")
        assertEquals("Main.kt", (line as TerminalLine.FileWrite).name)
    }
}
