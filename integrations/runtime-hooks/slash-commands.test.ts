import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodexSlashCommands,
  discoverGeminiSlashCommands,
  discoverSlashCommands,
} from "./slash-commands";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "agent-deck-commands-"));
  const userDir = join(root, "user");
  const projectDir = join(root, "project");
  const pluginRoot = join(root, "plugin-install");
  const write = (path: string, body: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  };
  const skill = (base: string, name: string, description?: string) =>
    write(
      join(base, name, "SKILL.md"),
      description === undefined
        ? `# ${name}`
        : `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}`,
    );
  const manifestPath = join(root, "installed_plugins.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ version: 2, plugins: { "figma@official": [{ installPath: pluginRoot }] } }),
  );
  return {
    roots: { userDir, projectDir, pluginManifest: manifestPath },
    write,
    skill,
    pluginRoot,
    manifestPath,
  };
}

describe("discoverSlashCommands", () => {
  test("finds prompt files and skills, with their descriptions", () => {
    const s = scratch();
    s.write(
      join(s.roots.userDir, "commands", "review.md"),
      "---\ndescription: Review the diff\n---\nDo it",
    );
    s.skill(join(s.roots.userDir, "skills"), "diagnose", "Debug hard failures");

    expect(discoverSlashCommands(s.roots)).toEqual([
      { name: "diagnose", description: "Debug hard failures", source: "user" },
      { name: "review", description: "Review the diff", source: "user" },
    ]);
  });

  test("nested prompt files use the runtime's namespace form", () => {
    const s = scratch();
    s.write(join(s.roots.userDir, "commands", "git", "sync.md"), "Sync it");

    expect(discoverSlashCommands(s.roots).map((c) => c.name)).toEqual(["git:sync"]);
  });

  test("installed plugin skills are prefixed with their plugin", () => {
    const s = scratch();
    s.skill(join(s.pluginRoot, "skills"), "deploy", "Ship it");

    expect(discoverSlashCommands(s.roots)).toEqual([
      { name: "figma:deploy", description: "Ship it", source: "plugin" },
    ]);
  });

  test("a project definition shadows the user one of the same name", () => {
    const s = scratch();
    s.skill(join(s.roots.userDir, "skills"), "review", "User copy");
    s.skill(join(s.roots.projectDir, ".claude", "skills"), "review", "Project copy");

    expect(discoverSlashCommands(s.roots)).toEqual([
      { name: "review", description: "Project copy", source: "project" },
    ]);
  });

  test("a skill without frontmatter still lists under its directory name", () => {
    const s = scratch();
    s.skill(join(s.roots.userDir, "skills"), "bare");

    expect(discoverSlashCommands(s.roots)).toEqual([
      { name: "bare", description: undefined, source: "user" },
    ]);
  });

  test("long descriptions are clipped so a phone can render the list", () => {
    const s = scratch();
    s.write(
      join(s.roots.userDir, "commands", "verbose.md"),
      `---\ndescription: ${"x".repeat(400)}\n---\n`,
    );

    const description = discoverSlashCommands(s.roots)[0]?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description.endsWith("…")).toBe(true);
  });

  test("missing directories and an unreadable manifest yield an empty list, not an error", () => {
    const s = scratch();
    expect(
      discoverSlashCommands({ ...s.roots, pluginManifest: join(s.roots.userDir, "nope.json") }),
    ).toEqual([]);
  });
  test("a YAML block scalar description is read as its text, not its marker", () => {
    const s = scratch();
    s.write(
      join(s.roots.userDir, "skills", "caveman", "SKILL.md"),
      "---\nname: caveman\ndescription: >\n  Ultra-compressed mode. Cuts token usage\n  while keeping accuracy.\n---\n\n# caveman",
    );

    expect(discoverSlashCommands(s.roots)[0]?.description).toBe(
      "Ultra-compressed mode. Cuts token usage while keeping accuracy.",
    );
  });
  test("frontmatter longer than one read still yields its description", () => {
    // The exact shape that lost every plugin skill's description: a real
    // description on line three, followed by a metadata block whose closing
    // delimiter sits past the bytes this is willing to read.
    const s = scratch();
    const padding = Array.from(
      { length: 400 },
      (_, index) => `  key${index}: "${"x".repeat(40)}"`,
    ).join("\n");
    s.write(
      join(s.roots.userDir, "skills", "huge", "SKILL.md"),
      `---\nname: huge\ndescription: Still discoverable.\nmetadata:\n${padding}\n---\n\nBody.\n`,
    );

    const huge = discoverSlashCommands(s.roots).find((command) => command.name === "huge");
    expect(huge).toBeDefined();
    expect(huge!.description).toBe("Still discoverable.");
  });
});

describe("discoverCodexSlashCommands", () => {
  test("reads prompts, skills, and the CLI's own .system skills from one codex dir", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-deck-codex-"));
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(
      join(root, "prompts", "ship.md"),
      "---\ndescription: Ship the release\n---\nDo it",
    );
    mkdirSync(join(root, "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(root, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the service\n---\n\n# deploy",
    );
    mkdirSync(join(root, "skills", ".system", "skill-creator"), { recursive: true });
    writeFileSync(
      join(root, "skills", ".system", "skill-creator", "SKILL.md"),
      "---\nname: skill-creator\ndescription: Create skills\n---\n\n# skill-creator",
    );

    expect(discoverCodexSlashCommands(root)).toEqual([
      { name: "deploy", description: "Deploy the service", source: "user" },
      { name: "ship", description: "Ship the release", source: "user" },
      { name: "skill-creator", description: "Create skills", source: "plugin" },
    ]);
  });

  test("a machine with no prompts directory yields an empty catalog, not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-deck-codex-empty-"));
    expect(discoverCodexSlashCommands(root)).toEqual([]);
  });
});

describe("discoverGeminiSlashCommands", () => {
  test("reads skills from both of Gemini's skill roots", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-deck-gemini-"));
    mkdirSync(join(root, "skills", "impeccable"), { recursive: true });
    writeFileSync(
      join(root, "skills", "impeccable", "SKILL.md"),
      "---\nname: impeccable\ndescription: Design pass\n---\n\n# impeccable",
    );
    mkdirSync(join(root, "config", "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(root, "config", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship it\n---\n\n# deploy",
    );

    expect(discoverGeminiSlashCommands(root)).toEqual([
      { name: "deploy", description: "Ship it", source: "user" },
      { name: "impeccable", description: "Design pass", source: "user" },
    ]);
  });

  test("no skills anywhere is an empty catalog, not an error", () => {
    expect(
      discoverGeminiSlashCommands(mkdtempSync(join(tmpdir(), "agent-deck-gem-empty-"))),
    ).toEqual([]);
  });
});
