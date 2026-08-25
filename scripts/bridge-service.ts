#!/usr/bin/env bun
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const label = "dev.agentdeck.bridge";
const uid = process.getuid?.() ?? Number(Bun.spawnSync(["id", "-u"]).stdout.toString().trim());
const domain = `gui/${uid}`;
const service = `${domain}/${label}`;
const projectRoot = resolve(import.meta.dir, "..");
const serverDirectory = join(projectRoot, "apps", "server");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const logDirectory = join(homedir(), "Library", "Logs", "AgentDeck");
const bun = Bun.which("bun") ?? process.execPath;
const command = process.argv[2] ?? "status";

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(bun)}</string><string>run</string><string>src/index.ts</string></array>
  <key>WorkingDirectory</key><string>${xml(serverDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(join(logDirectory, "bridge.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDirectory, "bridge.error.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(homedir())}</string>
    <key>PATH</key><string>${xml(process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
</dict>
</plist>
`;

function run(args: string[], allowFailure = false, quiet = false) {
  const result = Bun.spawnSync(args, {
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  if (!allowFailure && result.exitCode !== 0) process.exit(result.exitCode);
  return result.exitCode;
}

switch (command) {
  case "install":
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(plistPath, plist);
    run(["plutil", "-lint", plistPath]);
    run(["launchctl", "bootout", service], true);
    run(["launchctl", "bootstrap", domain, plistPath]);
    console.log(`Installed ${label}. It will start at login and restart after crashes.`);
    break;
  case "restart":
    run(["launchctl", "kickstart", "-k", service]);
    break;
  case "uninstall":
    run(["launchctl", "bootout", service], true);
    try {
      unlinkSync(plistPath);
    } catch {
      /* Already absent. */
    }
    console.log(`Uninstalled ${label}.`);
    break;
  case "status": {
    const loaded = run(["launchctl", "print", service], true, true) === 0;
    let healthy = false;
    try {
      healthy = (await fetch("http://127.0.0.1:3000/", { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      /* Offline. */
    }
    console.log(JSON.stringify({ loaded, healthy, plistPath, logs: logDirectory }, null, 2));
    if (!loaded || !healthy) process.exitCode = 1;
    break;
  }
  default:
    console.error("Usage: bun scripts/bridge-service.ts install|status|restart|uninstall");
    process.exit(2);
}
