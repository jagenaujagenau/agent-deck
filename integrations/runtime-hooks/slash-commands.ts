import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type SlashCommandSource = "project" | "user" | "plugin";
export type SlashCommand = { name: string; description?: string; source: SlashCommandSource };

/** Frontmatter sits at the top of the file; never read a whole skill body to find it. */
const FRONTMATTER_BYTES = 4_096;
const MAX_DESCRIPTION = 200;
/** A device has to render and filter these, and they ride in one response — keep the list bounded. */
const MAX_COMMANDS = 400;

function frontmatter(file: string): Record<string, string> {
  let head: string;
  try {
    head = readFileSync(file, "utf8").slice(0, FRONTMATTER_BYTES);
  } catch {
    return {};
  }
  if (!head.startsWith("---")) return {};
  const end = head.indexOf("\n---", 3);
  if (end === -1) return {};
  const fields: Record<string, string> = {};
  const lines = head.slice(3, end).split("\n");
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
    fields[key] = value.replace(/^["']|["']$/g, "");
  }
  return fields;
}

function describe(file: string, fields: Record<string, string>): string | undefined {
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
  const discovered = [
    ...commandsIn(join(roots.projectDir, ".claude", "commands"), "project"),
    ...skillsIn(join(roots.projectDir, ".claude", "skills"), "project"),
    ...commandsIn(join(roots.userDir, "commands"), "user"),
    ...skillsIn(join(roots.userDir, "skills"), "user"),
    ...pluginSkills(roots.pluginManifest),
  ];
  // Project definitions shadow user ones of the same name, exactly as the runtime resolves them.
  const byName = new Map<string, SlashCommand>();
  for (const command of discovered)
    if (!byName.has(command.name)) byName.set(command.name, command);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_COMMANDS);
}
