#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Builds, signs, notarizes, and writes the update manifest for the desktop app.
 *
 * Tauri signs and notarizes itself when the right variables are present, so this
 * does not re-implement either. What it adds is the part Tauri does not: the
 * `latest.json` the updater actually reads, assembled from the artifacts the
 * build just produced rather than written by hand against what they were
 * expected to be.
 */

const root = resolve(import.meta.dir, "..");
const desktop = join(root, "apps", "desktop");
const conf = JSON.parse(readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8")) as {
  version: string;
  productName: string;
};

const endpointBase = process.env.AGENT_DECK_UPDATE_BASE;
const identity = process.env.APPLE_SIGNING_IDENTITY;
const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;

const missing = [
  !identity &&
    "APPLE_SIGNING_IDENTITY (e.g. 'Developer ID Application: Diego Peralta (T7AG6F3KVC)')",
  !keychainProfile && "APPLE_KEYCHAIN_PROFILE (create with: xcrun notarytool store-credentials)",
  !endpointBase && "AGENT_DECK_UPDATE_BASE (e.g. https://example.dev/agentdeck)",
].filter(Boolean);
if (missing.length > 0) {
  console.error(`Cannot release without:\n${missing.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(2);
}

const signingKey =
  process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(process.env.HOME!, ".tauri", "agentdeck.key");
if (!existsSync(signingKey)) {
  console.error(
    `No updater signing key at ${signingKey}. Generate one with:\n  bunx tauri signer generate -w ${signingKey}`,
  );
  process.exit(2);
}

const build = Bun.spawnSync(["bunx", "tauri", "build"], {
  cwd: desktop,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    // The key's contents, not its path: Tauri reads the path variable only for
    // some operations and reports "public key found, no private key" for the
    // rest, which is a confusing way to be told the wrong variable was set.
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(signingKey, "utf8").trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    // Notarization is Tauri's to run; it only needs to be told who is asking.
    APPLE_SIGNING_IDENTITY: identity!,
    APPLE_KEYCHAIN_PROFILE: keychainProfile!,
  },
});
if (build.exitCode !== 0) process.exit(build.exitCode);

const bundle = join(desktop, "src-tauri", "target", "release", "bundle", "macos");
const archive = join(bundle, `${conf.productName}.app.tar.gz`);
const signaturePath = `${archive}.sig`;
if (!existsSync(signaturePath)) {
  console.error(
    `Build produced no updater signature at ${signaturePath}.\nIs bundle.createUpdaterArtifacts still true in tauri.conf.json?`,
  );
  process.exit(1);
}

const manifest = {
  version: conf.version,
  // Stamped from the build rather than the config so a re-published manifest
  // for the same version is still distinguishable from the one before it.
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature: readFileSync(signaturePath, "utf8").trim(),
      url: `${endpointBase}/${conf.version}/${encodeURIComponent(`${conf.productName}.app.tar.gz`)}`,
    },
  },
};
const manifestPath = join(bundle, "latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nSigned and notarized ${conf.productName} ${conf.version}`);
console.log(`  archive:  ${archive}`);
console.log(`  manifest: ${manifestPath}`);
console.log(
  `\nUpload the archive to ${endpointBase}/${conf.version}/ and the manifest to the URL in tauri.conf.json.`,
);
