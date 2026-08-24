#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Renders the launcher art at every density from one source image.
 *
 * Both apps ship adaptive icons only (minSdk 30), so there are no legacy square PNGs to composite:
 * the art is inset and placed over a background colour by `ic_launcher_foreground.xml`, and this
 * script only has to resize. That keeps the whole pipeline inside macOS's built-in `sips`.
 */
const SOURCE = resolve(import.meta.dir, "..", "apps", "android", "icon-source.png");
const MODULES = ["mobile", "wear"] as const;
/** An adaptive icon layer is 108dp; these are that at each density bucket. */
const DENSITIES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 } as const;

if (!existsSync(SOURCE)) {
  console.error(`No source icon at ${SOURCE}\n\nSave the artwork there (square PNG, transparent background preferred) and re-run.`);
  process.exit(1);
}

for (const module of MODULES) {
  const res = resolve(import.meta.dir, "..", "apps", "android", module, "src", "main", "res");
  for (const [density, size] of Object.entries(DENSITIES)) {
    const target = join(res, `mipmap-${density}`, "ic_launcher_art.png");
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    const result = Bun.spawnSync(["sips", "-s", "format", "png", "-z", String(size), String(size), SOURCE, "--out", target]);
    if (!result.success) {
      console.error(`sips failed for ${module}/${density}: ${result.stderr.toString().trim()}`);
      process.exit(1);
    }
    console.log(`${module}/mipmap-${density}/ic_launcher_art.png  ${size}×${size}`);
  }
}
// Point the foreground at the generated bitmap, replacing the placeholder vector.
for (const module of MODULES) {
  const foreground = resolve(import.meta.dir, "..", "apps", "android", module, "src", "main", "res", "drawable", "ic_launcher_foreground.xml");
  const xml = await Bun.file(foreground).text();
  await Bun.write(foreground, xml.replace("@drawable/ic_launcher_placeholder", "@mipmap/ic_launcher_art"));
}
console.log("\nForeground repointed at the generated artwork.");
console.log("Rebuild with: cd apps/android && ./gradlew :mobile:installDebug");
