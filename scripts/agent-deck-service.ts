#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Installs and inspects the launchd jobs Agent Deck runs in the background.
 *
 * Both jobs are generated from the one definition below, because the last plist
 * that was written by hand and then forgotten kept pointing at an entry point
 * deleted months earlier - failing 3,691 times while `status` called it healthy.
 * Regenerating every job from source on install is what stops a second one
 * rotting the same way.
 */

interface ServiceDefinition {
  readonly name: string;
  readonly label: string;
  /** Working directory, relative to the repository root. */
  readonly directory: string;
  /** Entry point, relative to `directory`. */
  readonly entry: string;
  readonly summary: string;
  /** How to tell it is doing its job, beyond launchd holding a pid. */
  readonly health?: () => Promise<{ ok: boolean; detail?: string }>;
}

/** What `status` reports for one job. */
interface ServiceStatus {
  name: string;
  installed: boolean;
  /** launchd holds the job. True even while the program crashes every launch. */
  loaded: boolean;
  running: boolean;
  pid?: number;
  lastExitCode?: number;
  entryExists: boolean;
  /** Absent when the service has nothing to answer on, which is not `false`. */
  healthy?: boolean;
  health?: string;
}

const projectRoot = resolve(import.meta.dir, "..");
const uid = process.getuid?.() ?? Number(Bun.spawnSync(["id", "-u"]).stdout.toString().trim());
const domain = `gui/${uid}`;
const logDirectory = join(homedir(), "Library", "Logs", "AgentDeck");
const bun = Bun.which("bun") ?? process.execPath;

/** The bridge answers this, and says which bridge it is. */
async function bridgeHealth() {
  try {
    const response = await fetch("http://127.0.0.1:3000/", { signal: AbortSignal.timeout(2_000) });
    // SAFETY: the shape is not trusted - both fields are checked below before
    // use, and a body of any other shape simply fails the name check.
    const body = (await response.json()) as { name?: string; version?: string };
    // A foreign server on the port is not this bridge being healthy.
    if (!response.ok || body.name !== "agent-deck-bridge") {
      return { ok: false, detail: "something else is answering port 3000" };
    }
    return { ok: true, detail: `v${body.version ?? "?"}` };
  } catch {
    return { ok: false, detail: "not answering port 3000" };
  }
}

const SERVICES: ReadonlyArray<ServiceDefinition> = [
  {
    name: "bridge",
    label: "dev.agentdeck.bridge",
    directory: join("apps", "server"),
    entry: join("src", "effect", "main.ts"),
    summary: "The bridge the phone, watch and adapters talk to",
    health: bridgeHealth,
  },
  {
    name: "herdr",
    label: "dev.agentdeck.herdr",
    directory: ".",
    entry: join("integrations", "herdr", "index.ts"),
    // No health check: it does its work in bursts against Herdr and the bridge,
    // and has nothing to answer on. A held pid is the whole claim being made.
    summary:
      "Reports terminal prompts the hooks cannot see, and delivers messages to idle sessions",
  },
];

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const plistPathFor = (service: ServiceDefinition) =>
  join(homedir(), "Library", "LaunchAgents", `${service.label}.plist`);

const serviceTargetFor = (service: ServiceDefinition) => `${domain}/${service.label}`;

const plistFor = (service: ServiceDefinition) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${service.label}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(bun)}</string><string>run</string><string>${xml(service.entry)}</string></array>
  <key>WorkingDirectory</key><string>${xml(join(projectRoot, service.directory))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(join(logDirectory, `${service.name}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDirectory, `${service.name}.error.log`))}</string>
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
 * What a job is actually doing, as opposed to whether it exists.
 *
 * "Loaded" only means launchd holds the job; it stays true while the program
 * crashes on every attempt. A pid is the proof that it is running.
 */
async function statusOf(service: ServiceDefinition) {
  const printed = Bun.spawnSync(["launchctl", "print", serviceTargetFor(service)]);
  const text = printed.stdout.toString();
  const pid = Number(/\bpid = (\d+)/.exec(text)?.[1] ?? 0) || undefined;
  const lastExitCode = Number(/last exit code = (\d+)/.exec(text)?.[1] ?? Number.NaN);
  const entryExists = existsSync(join(projectRoot, service.directory, service.entry));
  const report: ServiceStatus = {
    name: service.name,
    installed: existsSync(plistPathFor(service)),
    loaded: printed.exitCode === 0,
    running: pid !== undefined,
    pid,
    lastExitCode: Number.isFinite(lastExitCode) ? lastExitCode : undefined,
    // A plist naming an entry point that no longer exists is the exact failure
    // that went unnoticed for months, so it is reported rather than inferred.
    entryExists,
  };
  // Only services that can answer for themselves carry a health verdict; the
  // absence of the field says "nothing to ask", which is not the same as false.
  if (service.health) {
    const health = await service.health();
    report.healthy = health.ok;
    report.health = health.detail;
  }
  return report;
}

/**
 * Unloads a job and loads it again, waiting for the unload to actually finish.
 *
 * `bootout` returns before launchd has let go, so a `bootstrap` issued straight
 * after it fails with nothing but a suggestion to re-run as root - and leaves
 * the service down. This waits for the job to disappear before loading it, and
 * retries the load, because the window is short but real: it took the bridge
 * offline the first time this script installed over a running one.
 */
async function reload(service: ServiceDefinition, path: string) {
  const target = serviceTargetFor(service);
  run(["launchctl", "bootout", target], true, true);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (Bun.spawnSync(["launchctl", "print", target]).exitCode !== 0) break;
    await Bun.sleep(100);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (run(["launchctl", "bootstrap", domain, path], true, true) === 0) return;
    await Bun.sleep(200);
  }
  // Say so rather than reporting a successful install of a service that is down.
  console.error(`Could not load ${service.label}. Check: launchctl print ${target}`);
  process.exitCode = 1;
}

const selected = (name: string | undefined) =>
  name && name !== "all" ? SERVICES.filter((service) => service.name === name) : SERVICES;

const command = process.argv[2] ?? "status";
const which = process.argv[3];
const chosen = selected(which);
if (chosen.length === 0) {
  console.error(`Unknown service "${which}". Known: ${SERVICES.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

switch (command) {
  case "install": {
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    for (const service of chosen) {
      const path = plistPathFor(service);
      const next = plistFor(service);
      const changed = !existsSync(path) || readFileSync(path, "utf8") !== next;
      writeFileSync(path, next);
      run(["plutil", "-lint", path], false, true);
      await reload(service, path);
      console.log(`Installed ${service.label}${changed ? "" : " (definition unchanged)"}`);
    }
    break;
  }
  case "restart":
    for (const service of chosen) run(["launchctl", "kickstart", "-k", serviceTargetFor(service)]);
    break;
  case "uninstall":
    for (const service of chosen) {
      run(["launchctl", "bootout", serviceTargetFor(service)], true, true);
      try {
        unlinkSync(plistPathFor(service));
      } catch {
        /* Already absent. */
      }
      console.log(`Uninstalled ${service.label}`);
    }
    break;
  case "status": {
    const report = [];
    for (const service of chosen) report.push(await statusOf(service));
    console.log(JSON.stringify(report, null, 2));
    const unwell = report.some(
      (entry) => !entry.running || entry.healthy === false || !entry.entryExists,
    );
    if (unwell) process.exitCode = 1;
    break;
  }
  default:
    console.error(
      `Usage: bun scripts/agent-deck-service.ts install|status|restart|uninstall [${SERVICES.map((s) => s.name).join("|")}|all]`,
    );
    process.exit(2);
}
