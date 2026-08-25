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
  <array><string>${xml(bun)}</string><string>run</string><string>src/effect/main.ts</string></array>
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

/**
 * What the service is actually doing, as opposed to whether it exists.
 *
 * "Loaded" only means launchd holds the job; it stays true while the program
 * crashes on every attempt. The installed plist once pointed at an entry point
 * that had been deleted, and this reported a healthy bridge through 3,691
 * consecutive failed launches - because a stray process happened to be holding
 * the port. So a pid is what proves it is running, and the answer on the port
 * has to identify itself as the bridge rather than merely arrive.
 */
async function status() {
  const printed = Bun.spawnSync(["launchctl", "print", service]);
  const loaded = printed.exitCode === 0;
  const text = printed.stdout.toString();
  const pid = Number(/\bpid = (\d+)/.exec(text)?.[1] ?? 0) || undefined;
  const lastExitCode = Number(/last exit code = (\d+)/.exec(text)?.[1] ?? Number.NaN);
  let healthy = false;
  let version: string | undefined;
  try {
    const response = await fetch("http://127.0.0.1:3000/", { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as { name?: string; version?: string };
    // A foreign server on the port is not this bridge being healthy.
    healthy = response.ok && body.name === "agent-deck-bridge";
    version = body.version;
  } catch {
    /* Offline, or something else is holding the port. */
  }
  return {
    loaded,
    running: pid !== undefined,
    healthy,
    pid,
    lastExitCode: Number.isFinite(lastExitCode) ? lastExitCode : undefined,
    version,
    plistPath,
    logs: logDirectory,
  };
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
    const current = await status();
    console.log(JSON.stringify(current, null, 2));
    if (!current.running || !current.healthy) process.exitCode = 1;
    break;
  }
  default:
    console.error("Usage: bun scripts/bridge-service.ts install|status|restart|uninstall");
    process.exit(2);
}
