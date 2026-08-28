import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type SlashCommandSource = "project" | "user" | "plugin";
export type SlashCommand = { name: string; description?: string; source: SlashCommandSource };

/** Frontmatter sits at the top of the file; never read a whole skill body to find it. */
const FRONTMATTER_BYTES = 4_096;
const MAX_DESCRIPTION = 200;
/** A device has to render and filter these, and they ride in one response — keep the list bounded. */
const MAX_COMMANDS = 400;

/** The two frontmatter fields the deck reads; the rest of the block is skipped, not kept. */
type Frontmatter = { name?: string; description?: string };

function frontmatter(file: string): Frontmatter {
  let head: string;
  try {
    head = readFileSync(file, "utf8").slice(0, FRONTMATTER_BYTES);
  } catch {
    return {};
  }
  if (!head.startsWith("---")) return {};
  // A skill may carry a long metadata block, and its closing delimiter can sit
  // past the window this is willing to read. Whatever is in the window is still
  // worth parsing: refusing everything for want of the delimiter lost the
  // description of every plugin skill with sizeable frontmatter, and that
  // description is on the third line.
  const end = head.indexOf("\n---", 3);
  const fields: Frontmatter = {};
  const lines = head.slice(3, end === -1 ? undefined : end).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[index].trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      // A YAML block scalar: the value is the indented lines that follow, not the marker itself.
      const block: string[] = [];
      while (
        index + 1 < lines.length &&
        (lines[index + 1].trim() === "" || /^\s+\S/.test(lines[index + 1]))
      ) {
        index += 1;
        block.push(lines[index].trim());
      }
      value = block.join(" ").trim();
    }
    // Every key participates in the scan — a block scalar under any key has to be
    // consumed to keep line positions honest — but only the two named fields are kept.
    const cleaned = value.replace(/^["']|["']$/g, "");
    if (key === "name") fields.name = cleaned;
    if (key === "description") fields.description = cleaned;
  }
  return fields;
}

function describe(file: string, fields: Frontmatter): string | undefined {
  const description = fields.description?.trim();
  if (description)
    return description.length > MAX_DESCRIPTION
      ? `${description.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`
      : description;
  return undefined;
}

function directories(parent: string): string[] {
  try {
    return readdirSync(parent).filter((entry) => {
      try {
        return statSync(join(parent, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** `commands/review.md` is `/review`; a nested `commands/git/sync.md` is `/git:sync`. */
function commandsIn(root: string, source: SlashCommandSource): SlashCommand[] {
  const found: SlashCommand[] = [];
  const walk = (directory: string, prefix: string) => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        if (!prefix) walk(path, `${entry}:`);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const fields = frontmatter(path);
      found.push({
        name: `${prefix}${basename(entry, ".md")}`,
        description: describe(path, fields),
        source,
      });
    }
  };
  walk(root, "");
  return found;
}

function skillsIn(root: string, source: SlashCommandSource, namespace = ""): SlashCommand[] {
  return directories(root).flatMap((directory) => {
    const file = join(root, directory, "SKILL.md");
    if (!existsSync(file)) return [];
    const fields = frontmatter(file);
    return [
      {
        name: `${namespace}${fields.name || directory}`,
        description: describe(file, fields),
        source,
      },
    ];
  });
}

function pluginSkills(manifestPath: string): SlashCommand[] {
  let manifest: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
  return Object.entries(manifest.plugins ?? {}).flatMap(([key, installs]) => {
    // Keys are `<plugin>@<marketplace>`; the invocable prefix is the plugin alone.
    const plugin = key.split("@")[0];
    const installPath = installs?.[0]?.installPath;
    if (!plugin || !installPath) return [];
    return skillsIn(join(installPath, "skills"), "plugin", `${plugin}:`);
  });
}

/**
 * Everything this session can be asked to run by name. Only model-invocable things are listed —
 * prompt files and skills — never the client's own built-ins like `/clear`, which a remote message
 * has no way to trigger.
 */
export function discoverSlashCommands(roots: {
  userDir: string;
  projectDir: string;
  pluginManifest: string;
}): SlashCommand[] {
  return dedupe([
    ...commandsIn(join(roots.projectDir, ".claude", "commands"), "project"),
    ...skillsIn(join(roots.projectDir, ".claude", "skills"), "project"),
    ...commandsIn(join(roots.userDir, "commands"), "user"),
    ...skillsIn(join(roots.userDir, "skills"), "user"),
    ...pluginSkills(roots.pluginManifest),
  ]);
}

/**
 * The Codex layout: custom prompts in `prompts/*.md`, skills in `skills/`
 * with the same SKILL.md frontmatter Claude uses, and the CLI's built-in
 * skills one level down in `skills/.system/`. Codex has no per-project
 * command directory or plugin manifest to read.
 */
export function discoverCodexSlashCommands(codexDir: string): SlashCommand[] {
  return dedupe([
    ...commandsIn(join(codexDir, "prompts"), "user"),
    ...skillsIn(join(codexDir, "skills"), "user"),
    ...skillsIn(join(codexDir, "skills", ".system"), "plugin"),
  ]);
}

/**
 * The Gemini CLI layout: skills under `skills/` and `config/skills/`, both in
 * the same SKILL.md frontmatter grammar (verified against a real ~/.gemini).
 */
export function discoverGeminiSlashCommands(geminiDir: string): SlashCommand[] {
  return dedupe([
    ...skillsIn(join(geminiDir, "skills"), "user"),
    ...skillsIn(join(geminiDir, "config", "skills"), "user"),
  ]);
}

function dedupe(discovered: SlashCommand[]): SlashCommand[] {
  // Earlier roots shadow later ones of the same name, exactly as the runtime resolves them.
  const byName = new Map<string, SlashCommand>();
  for (const command of discovered)
    if (!byName.has(command.name)) byName.set(command.name, command);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_COMMANDS);
}
