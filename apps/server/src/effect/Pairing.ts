import { networkInterfaces } from "node:os";
import qrcode from "qrcode-generator";

/**
 * Who may pair a phone with this bridge, and what the invitation says.
 *
 * The rules only — the page a person actually looks at is `PairingPage.ts`,
 * which renders these answers.
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
