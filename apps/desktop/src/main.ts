import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";

/**
 * The window is the detail view; the menu bar is the app.
 *
 * Everything here is a read of state the Rust side already polls, so the page
 * renders what it is handed rather than keeping a timer of its own. A window
 * that is hidden most of the time is a poor place to own the truth.
 */

type Health = "Serving" | "Starting" | "Failing" | "Stopped" | "NotInstalled";

interface ServiceStatus {
  name: string;
  summary: string;
  health: Health;
  pid?: number;
  last_exit_code?: number;
  version?: string;
  port_taken_by_other: boolean;
}

interface Harness {
  id: string;
  name: string;
  config_path: string;
  installed: boolean;
  present: boolean;
}

const app = document.querySelector<HTMLElement>("#app")!;

const HEALTH_TEXT = {
  Serving: "Serving",
  Starting: "Starting",
  Failing: "Failing to start",
  Stopped: "Stopped",
  NotInstalled: "Service not installed",
} satisfies Record<Health, string>;

const DOT_CLASS = {
  Serving: "serving",
  Starting: "starting",
  Failing: "failing",
  Stopped: "",
  NotInstalled: "",
} satisfies Record<Health, string>;

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/**
 * The line under the status, which says the most useful true thing available.
 *
 * A failing service is the case worth spelling out: it is the one a person
 * cannot diagnose from the tray glyph alone, and the exit code is the first
 * thing they would go looking for.
 */
function detail(status: ServiceStatus): string {
  if (status.port_taken_by_other) {
    return "Something else is answering on port 3000 — the bridge cannot bind it.";
  }
  switch (status.health) {
    case "Serving":
      return status.pid ? `pid ${status.pid}` : "";
    case "Failing":
      return status.last_exit_code === undefined
        ? "launchd holds the job but it exits immediately."
        : `Exits immediately with code ${status.last_exit_code}. Check ~/Library/Logs/AgentDeck.`;
    case "NotInstalled":
      return `Run: bun scripts/agent-deck-service.ts install ${status.name}`;
    default:
      return "";
  }
}

let harnesses: Harness[] = [];
let services: ServiceStatus[] = [];
let appVersion = "";
let notice = "";
let info = "";

/** One service, with the controls that make sense for the state it is in. */
function serviceCard(status: ServiceStatus): string {
  const line = detail(status);
  const running = status.health === "Serving" || status.health === "Starting";
  return `
    <div class="card">
      <div class="status">
        <span class="dot ${DOT_CLASS[status.health]}"></span>
        <strong>${escape(status.name)}</strong>
        <span class="pill">${HEALTH_TEXT[status.health]}</span>
        ${status.version ? `<span class="pill">v${escape(status.version)}</span>` : ""}
      </div>
      <div class="path">${escape(status.summary)}</div>
      ${line ? `<div class="meta">${escape(line)}</div>` : ""}
      <div class="actions">
        <button data-act="start" data-name="${escape(status.name)}" ${running ? "disabled" : ""}>Start</button>
        <button data-act="stop" data-name="${escape(status.name)}" ${running ? "" : "disabled"}>Stop</button>
        <button data-act="restart" data-name="${escape(status.name)}">Restart</button>
      </div>
    </div>`;
}

function render() {
  if (services.length === 0) {
    app.innerHTML = `<h1>Agent Deck</h1><p class="muted">Reading the services…</p>`;
    return;
  }
  const bridgeVersion = services.find((service) => service.version)?.version;
  app.innerHTML = `
    <h1>Agent Deck</h1>
    <p class="muted">Menu bar control for the bridge</p>

    <h2>Services</h2>
    <div class="stack">${services.map(serviceCard).join("")}</div>

    <h2>Agent harnesses</h2>
    <div class="card">
      ${harnesses
        .map(
          (harness) => `
        <div class="row">
          <div>
            <div class="name">${escape(harness.name)}</div>
            <div class="path">${escape(harness.config_path)}</div>
          </div>
          ${
            harness.installed
              ? `<span class="pill on">Connected</span>`
              : harness.present
                ? `<button data-install="${escape(harness.id)}">Connect</button>`
                : `<span class="pill">Not installed</span>`
          }
        </div>`,
        )
        .join("")}
    </div>
    ${notice ? `<div class="error">${escape(notice)}</div>` : ""}
    ${info ? `<div class="info">${escape(info)}</div>` : ""}

    <h2>About</h2>
    <div class="card">
      <div class="row">
        <div><div class="name">Agent Deck</div><div class="path">Desktop app</div></div>
        <span class="pill">v${escape(appVersion)}</span>
      </div>
      <div class="row">
        <div><div class="name">Bridge</div><div class="path">Reported by the running service</div></div>
        <span class="pill">${bridgeVersion ? `v${escape(bridgeVersion)}` : "—"}</span>
      </div>
      <div class="actions"><button id="update">Check for updates</button></div>
    </div>
  `;
  wire();
}

async function act(action: () => Promise<void>) {
  notice = "";
  info = "";
  try {
    await action();
  } catch (error) {
    notice = String(error);
  }
  await refresh();
}

function wire() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-act]")) {
    button.addEventListener("click", () => {
      const name = button.dataset.name!;
      const command = `service_${button.dataset.act}`;
      void act(() => invoke<void>(command, { name }));
    });
  }
  document.querySelector("#update")?.addEventListener("click", () => {
    void act(async () => {
      const update = await check();
      info = update ? `Update ${update.version} available` : "Already up to date.";
    });
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-install]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.install!;
      button.disabled = true;
      void act(async () => {
        await invoke<string>("harness_install", { id });
      });
    });
  }
}

async function refresh() {
  [services, harnesses] = await Promise.all([
    invoke<ServiceStatus[]>("service_status"),
    invoke<Harness[]>("harness_list"),
  ]);
  render();
}

appVersion = await invoke<string>("app_version");
await refresh();
// The Rust side already watches the service; take its word rather than polling.
void listen<ServiceStatus[]>("service-status", (event) => {
  services = event.payload;
  render();
});
