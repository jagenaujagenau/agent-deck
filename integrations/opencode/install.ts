#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Installs the plugin as one bundled file.
 *
 * Bundled rather than symlinked, which is how the Pi extension is installed:
 * OpenCode loads individual files from its plugins directory, and a plugin that
 * imports across the repository would resolve nothing from there. Bundling also
 * means the installed artifact keeps working when the checkout moves, which is
 * where all of this is heading anyway.
 */

const source = resolve(import.meta.dir, "index.ts");
const pluginsDir = join(homedir(), ".config", "opencode", "plugins");
const target = join(pluginsDir, "agent-deck.js");

const HEADER = `// Installed by Agent Deck. Generated from integrations/opencode/index.ts.
// Managed by the installer; reinstalling overwrites this file.
// Add your own plugins beside it rather than editing here.
`;

/** Refuses to overwrite a file this installer did not write. */
if (existsSync(target) && !readFileSync(target, "utf8").startsWith("// Installed by Agent Deck")) {
  console.error(`${target} exists and was not written by Agent Deck. Move it aside first.`);
  process.exit(1);
}

mkdirSync(pluginsDir, { recursive: true });

const build = await Bun.build({
  entrypoints: [source],
  target: "bun",
  format: "esm",
  // OpenCode provides this at runtime; bundling it would ship a second copy of
  // the host's own API.
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
});

if (!build.success) {
  console.error("Could not bundle the OpenCode plugin:");
  for (const log of build.logs) console.error(`  ${log}`);
  process.exit(1);
}

const [artifact] = build.outputs;
if (artifact === undefined) {
  console.error("Bundle produced no output.");
  process.exit(1);
}

writeFileSync(target, `${HEADER}${await artifact.text()}`);
console.log(`Installed Agent Deck OpenCode plugin at ${target}`);
console.log("Restart any running OpenCode sessions to load it.");
