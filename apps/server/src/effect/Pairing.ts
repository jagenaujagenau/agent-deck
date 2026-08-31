import { networkInterfaces } from "node:os";
import qrcode from "qrcode-generator";

/**
 * The bridge's own pairing surface: everything a person at this machine needs
 * to put the deck on a phone, served as one page.
 *
 * The page and its endpoints answer only to loopback. The trust model has
 * always been "whoever can read this machine's log may pair" — the code is
 * printed there — and a page reachable from the LAN would quietly widen that
 * to "whoever can reach the port". Loopback keeps the boundary where it was.
 */

/** Whether a request came from this machine itself. Absent means no. */
export const isLoopback = (address: string | undefined): boolean => {
  if (!address) return false;
  const bare = address.replace(/^::ffff:/i, "");
  return bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.");
};

/**
 * The desk-only surface: paths that answer to this machine and nobody else.
 *
 * One list, read twice — by the routes that carry the gate and by the auth
 * middleware that lets them past bearer credentials. Split in two, as it was,
 * the middleware waved every `/pair/*` path through on the *assumption* that
 * each handler checked its peer, and a fifth route would have shipped both
 * unauthenticated and LAN-reachable with nothing failing. Adding a path here
 * is what makes it desk-only; forgetting to is what a reviewer can see.
 */
export const LOOPBACK_ONLY_PATHS: ReadonlyArray<string> = ["/pair", "/pair/code", "/pair/devices"];

/** Whether a path is one of the desk-only ones, `:deviceId` tails included. */
export const isLoopbackOnlyPath = (path: string): boolean =>
  LOOPBACK_ONLY_PATHS.some((only) => path === only || path.startsWith(`${only}/`));

export type BridgeAddress = { kind: "lan" | "tailscale"; url: string };

/**
 * Where a phone can reach this bridge: the machine's LAN address, and its
 * tailnet address when Tailscale is up. Tailscale hands out 100.64.0.0/10 —
 * the CGNAT range — which is how its interface is told apart from the LAN.
 */
export const bridgeAddresses = (port: number): BridgeAddress[] => {
  const addresses: BridgeAddress[] = [];
  for (const interfaceAddresses of Object.values(networkInterfaces())) {
    for (const entry of interfaceAddresses ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [first = 0, second = 0] = entry.address.split(".").map(Number);
      const tailscale = first === 100 && second >= 64 && second <= 127;
      const kind = tailscale ? "tailscale" : "lan";
      if (!addresses.some((known) => known.kind === kind)) {
        addresses.push({ kind, url: `http://${entry.address}:${port}` });
      }
    }
  }
  return addresses.sort((a, b) => a.kind.localeCompare(b.kind));
};

/** What the QR says: the deep link both phone apps answer by pairing. */
export const pairLink = (url: string, code: string): string =>
  `agentdeck://pair?url=${encodeURIComponent(url)}&code=${code}`;

export const qrSvg = (text: string): string => {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
};

/** The POST /pair/code answer: a fresh code and a QR per reachable address. */
export const pairingPayload = (
  code: string,
  expiresAt: string,
  port: number,
  bridgeName: string,
) => ({
  code,
  expiresAt,
  bridgeName,
  addresses: bridgeAddresses(port).map((address) => ({
    ...address,
    qrSvg: qrSvg(pairLink(address.url, code)),
  })),
});

export const pairingPage = (bridgeName: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair a phone · ${escapeHtml(bridgeName)}</title>
<style>
  :root {
    --ink: #090C10; --surface: #11161C; --raised: #181E25; --sunken: #0E1319;
    --line: #252D36; --text: #F2F5F7; --muted: #8D99A6;
    --signal: #83E6B2; --amber: #FFC266; --danger: #FF7B7B; --blue: #8CB7FF;
  }
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    margin: 0; background: var(--ink); color: var(--text);
    font: 15px/1.5 -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  ::selection { background: rgba(131, 230, 178, 0.28); }
  :focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; border-radius: 6px; }
  main { max-width: 880px; margin: 0 auto; padding: 40px 24px 64px; }
  .wordmark { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: var(--signal); }
  .bridge-name { color: var(--muted); font-size: 13px; margin-top: 2px; }
  h1 { font-size: 28px; letter-spacing: -0.02em; margin: 28px 0 6px; }
  .lede { color: var(--muted); margin: 0 0 26px; max-width: 52ch; }
  .pair-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; align-items: start; }
  @media (max-width: 720px) { .pair-grid { grid-template-columns: minmax(0, 1fr); } }

  .pills { display: inline-flex; gap: 6px; background: var(--surface); border: 1px solid var(--line);
    border-radius: 999px; padding: 4px; }
  .pills button { border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13px;
    padding: 6px 14px; border-radius: 999px; cursor: pointer; }
  .pills button[aria-pressed="true"] { background: rgba(131, 230, 178, 0.16); color: var(--signal); font-weight: 600; }
  .pills button:disabled { opacity: 0.45; cursor: default; }
  .toggles { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 22px; }

  ol.steps { margin: 0 0 24px; padding-left: 22px; display: grid; gap: 10px; }
  ol.steps li::marker { color: var(--muted); }

  .field { display: flex; align-items: center; gap: 10px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; margin-bottom: 10px; }
  .field .label { color: var(--muted); font-size: 12px; min-width: 64px; }
  .field code { font: 15px/1.4 ui-monospace, "SF Mono", Menlo, monospace; color: var(--text);
    overflow-wrap: anywhere; }
  .field code.code-value { font-size: 22px; letter-spacing: 0.22em; color: var(--amber); }
  .field .grow { flex: 1; min-width: 0; }
  button.ghost { border: 1px solid var(--line); background: transparent; color: var(--muted);
    font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 8px; cursor: pointer; }
  button.ghost:hover { color: var(--text); border-color: var(--muted); }
  .expiry { color: var(--muted); font-size: 12px; margin: 4px 2px 0; }
  .expiry.expired { color: var(--danger); }

  .qr-card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px;
    padding: 20px; text-align: center; opacity: 0; transform: translateY(6px);
    transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1), transform 0.35s cubic-bezier(0.16, 1, 0.3, 1); }
  .qr-card.ready { opacity: 1; transform: none; }
  .qr-frame { background: #fff; border-radius: 12px; padding: 14px; display: block; }
  .qr-frame svg { display: block; width: 100%; height: auto; }
  .qr-caption { color: var(--muted); font-size: 12px; margin-top: 12px; }
  .qr-missing { color: var(--muted); font-size: 13px; padding: 40px 10px; }

  h2 { font-size: 15px; margin: 40px 0 4px; }
  .devices-hint { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
  ul.devices { list-style: none; margin: 0; padding: 0; }
  ul.devices li { display: flex; align-items: center; gap: 12px; padding: 12px 2px;
    border-bottom: 1px solid var(--line); }
  ul.devices .presence { width: 8px; height: 8px; border-radius: 50%; background: var(--line); flex: none; }
  ul.devices .presence.live { background: var(--signal); }
  ul.devices .name { font-weight: 600; }
  ul.devices .seen { color: var(--muted); font-size: 12px; flex: 1; }
  ul.devices button { border: 0; background: transparent; color: var(--muted); font: inherit;
    font-size: 12px; cursor: pointer; padding: 5px 9px; border-radius: 7px; }
  ul.devices button:hover { color: var(--danger); background: rgba(255, 123, 123, 0.10); }
  .devices-empty { color: var(--muted); font-size: 13px; padding: 14px 2px; }
  .local-note { color: var(--muted); font-size: 12px; margin-top: 40px; }
</style>
</head>
<body>
<main>
  <div class="wordmark">Agent Deck</div>
  <div class="bridge-name" id="bridge-name">${escapeHtml(bridgeName)}</div>
  <h1>Pair a phone</h1>
  <p class="lede">Put this deck on a phone: scan the code with its camera, and the app pairs itself.</p>

  <div class="pair-grid">
    <section>
      <div class="toggles">
        <div class="pills" role="group" aria-label="Phone platform" id="platform-pills">
          <button aria-pressed="true" data-platform="ios">iPhone</button>
          <button aria-pressed="false" data-platform="android">Android</button>
        </div>
        <div class="pills" role="group" aria-label="Network route" id="route-pills">
          <button aria-pressed="true" data-route="lan">Wi-Fi</button>
          <button aria-pressed="false" data-route="tailscale" id="tailscale-pill">Tailscale</button>
        </div>
      </div>

      <ol class="steps">
        <li id="step-install">Install Agent Deck on the phone via TestFlight.</li>
        <li id="step-network">Put the phone on the same Wi-Fi as this machine.</li>
        <li>Scan the code with the phone's camera — it opens Agent Deck and pairs.</li>
        <li>Or open the app's bridge settings and enter the address and code by hand:</li>
      </ol>

      <div class="field">
        <span class="label">Address</span>
        <code class="grow" id="address">…</code>
        <button class="ghost" data-copy="address">Copy</button>
      </div>
      <div class="field">
        <span class="label">Code</span>
        <code class="grow code-value" id="code">······</code>
        <button class="ghost" data-copy="code">Copy</button>
        <button class="ghost" id="new-code">New code</button>
      </div>
      <p class="expiry" id="expiry"></p>
    </section>

    <aside class="qr-card" id="qr-card" aria-label="Pairing QR code">
      <span class="qr-frame" id="qr"></span>
      <p class="qr-caption" id="qr-caption">Opens Agent Deck on the phone</p>
    </aside>
  </div>

  <h2>Paired devices</h2>
  <p class="devices-hint">Every phone and watch holding a live credential for this bridge.</p>
  <ul class="devices" id="devices"></ul>
  <p class="local-note">This page answers only on this machine — pairing stays something you do at the desk.</p>
</main>
<script>
(function () {
  "use strict";
  var state = { platform: "ios", route: "lan", payload: null };

  function el(id) { return document.getElementById(id); }

  function currentAddress() {
    if (!state.payload) return null;
    var match = null;
    for (var i = 0; i < state.payload.addresses.length; i++) {
      if (state.payload.addresses[i].kind === state.route) match = state.payload.addresses[i];
    }
    return match;
  }

  function render() {
    var address = currentAddress();
    el("address").textContent = address ? address.url : "No " + (state.route === "lan" ? "LAN" : "Tailscale") + " address found";
    el("code").textContent = state.payload ? state.payload.code : "······";
    el("step-install").textContent = state.platform === "ios"
      ? "Install Agent Deck on the phone via TestFlight."
      : "Install the Agent Deck app on the phone.";
    el("step-network").textContent = state.route === "lan"
      ? "Put the phone on the same Wi-Fi as this machine."
      : "Make sure the phone is signed in to your tailnet.";
    var qr = el("qr");
    if (address) {
      qr.innerHTML = address.qrSvg;
      el("qr-caption").textContent = "Opens Agent Deck on the phone";
    } else {
      qr.innerHTML = "<span class='qr-missing'>No address on this route</span>";
      el("qr-caption").textContent = "";
    }
    el("qr-card").classList.add("ready");
  }

  function renderExpiry() {
    if (!state.payload) return;
    var left = Math.floor((Date.parse(state.payload.expiresAt) - Date.now()) / 1000);
    var node = el("expiry");
    if (left <= 0) {
      node.textContent = "This code has expired — mint a new one.";
      node.className = "expiry expired";
      return;
    }
    var minutes = Math.floor(left / 60);
    var seconds = String(left % 60).padStart(2, "0");
    node.textContent = "One-time code · expires in " + minutes + ":" + seconds;
    node.className = "expiry";
  }

  function mint() {
    fetch("/pair/code", { method: "POST" })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        state.payload = payload;
        var hasTailscale = payload.addresses.some(function (a) { return a.kind === "tailscale"; });
        el("tailscale-pill").disabled = !hasTailscale;
        el("tailscale-pill").title = hasTailscale ? "" : "No Tailscale interface on this machine";
        if (!hasTailscale && state.route === "tailscale") state.route = "lan";
        render();
        renderExpiry();
      });
  }

  function freshness(iso) {
    var seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 45) return "now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
    return Math.floor(seconds / 86400) + "d ago";
  }

  function loadDevices() {
    fetch("/pair/devices")
      .then(function (response) { return response.json(); })
      .then(function (devices) {
        var list = el("devices");
        list.innerHTML = "";
        if (devices.length === 0) {
          var empty = document.createElement("p");
          empty.className = "devices-empty";
          empty.textContent = "Nothing paired yet.";
          list.appendChild(empty);
          return;
        }
        devices.forEach(function (device) {
          var item = document.createElement("li");
          // Presence is the registry's answer, not this page's arithmetic:
          // the rule that a device token touches last_seen_at on every call
          // belongs where the touching happens.
          var live = device.present === true;
          var dot = document.createElement("span");
          dot.className = live ? "presence live" : "presence";
          dot.title = live ? "Connected now" : "Not connected";
          var name = document.createElement("span");
          name.className = "name";
          name.textContent = device.name;
          var seen = document.createElement("span");
          seen.className = "seen";
          seen.textContent = "last seen " + freshness(device.lastSeenAt);
          var revoke = document.createElement("button");
          revoke.textContent = "Revoke";
          revoke.addEventListener("click", function () {
            if (!confirm("Revoke " + device.name + "? It will need to pair again.")) return;
            fetch("/pair/devices/" + encodeURIComponent(device.id), { method: "DELETE" }).then(loadDevices);
          });
          item.appendChild(dot);
          item.appendChild(name);
          item.appendChild(seen);
          item.appendChild(revoke);
          list.appendChild(item);
        });
      });
  }

  document.querySelectorAll("#platform-pills button").forEach(function (button) {
    button.addEventListener("click", function () {
      state.platform = button.dataset.platform;
      document.querySelectorAll("#platform-pills button").forEach(function (other) {
        other.setAttribute("aria-pressed", String(other === button));
      });
      render();
    });
  });
  document.querySelectorAll("#route-pills button").forEach(function (button) {
    button.addEventListener("click", function () {
      if (button.disabled) return;
      state.route = button.dataset.route;
      document.querySelectorAll("#route-pills button").forEach(function (other) {
        other.setAttribute("aria-pressed", String(other === button));
      });
      render();
    });
  });
  document.querySelectorAll("button[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var value = el(button.dataset.copy).textContent;
      navigator.clipboard.writeText(value).then(function () {
        var was = button.textContent;
        button.textContent = "Copied";
        setTimeout(function () { button.textContent = was; }, 1200);
      });
    });
  });
  el("new-code").addEventListener("click", mint);

  mint();
  loadDevices();
  setInterval(renderExpiry, 1000);
  setInterval(loadDevices, 5000);
})();
</script>
</body>
</html>
`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
