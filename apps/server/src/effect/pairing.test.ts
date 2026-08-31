import { describe, expect, test } from "bun:test";
import {
  LOOPBACK_ONLY_PATHS,
  bridgeAddresses,
  isLoopback,
  isLoopbackOnlyPath,
  pairLink,
  pairingPayload,
  qrSvg,
} from "./Pairing";

describe("isLoopback", () => {
  test("accepts the machine's own addresses in every dressing", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.53")).toBe(true);
  });

  test("refuses everything else, absent peers included", () => {
    expect(isLoopback("192.168.178.20")).toBe(false);
    expect(isLoopback("100.101.102.103")).toBe(false);
    // Fail closed: a request whose peer cannot be read is not local.
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback("")).toBe(false);
  });
});

describe("bridgeAddresses", () => {
  test("carries the bridge's port and only known kinds", () => {
    for (const address of bridgeAddresses(3123)) {
      expect(address.url).toEndWith(":3123");
      expect(address.url).toStartWith("http://");
      expect(["lan", "tailscale"]).toContain(address.kind);
    }
  });

  test("offers each route at most once", () => {
    const kinds = bridgeAddresses(3000).map((address) => address.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe("the QR", () => {
  test("says the deep link both phone apps answer by pairing", () => {
    expect(pairLink("http://192.168.1.5:3000", "123456")).toBe(
      "agentdeck://pair?url=http%3A%2F%2F192.168.1.5%3A3000&code=123456",
    );
  });

  test("renders as scalable SVG", () => {
    const svg = qrSvg(pairLink("http://192.168.1.5:3000", "123456"));
    expect(svg).toStartWith("<svg");
    expect(svg).toContain("viewBox");
  });
});

describe("pairingPayload", () => {
  test("pairs every reachable address with its own QR", () => {
    const payload = pairingPayload("654321", "2026-08-31T12:00:00Z", 3000, "Desk bridge");
    expect(payload.code).toBe("654321");
    expect(payload.bridgeName).toBe("Desk bridge");
    for (const address of payload.addresses) {
      expect(address.qrSvg).toStartWith("<svg");
    }
  });
});

describe("the desk-only surface", () => {
  test("every declared path is recognised, tails included", () => {
    for (const path of LOOPBACK_ONLY_PATHS) {
      expect(isLoopbackOnlyPath(path)).toBe(true);
    }
    // `/pair/devices/:deviceId` is the same surface as its parent — and so is
    // anything else beneath a declared path, which is the safe direction: an
    // unserved path under the desk surface 404s, while one wrongly treated as
    // public would answer the LAN.
    expect(isLoopbackOnlyPath("/pair/devices/abc-123")).toBe(true);
    expect(isLoopbackOnlyPath("/pair/anything-new")).toBe(true);
  });

  test("a path that merely starts alike is not desk-only", () => {
    // A sibling name is a different path: only the declared ones and what
    // sits beneath them are the desk's.
    expect(isLoopbackOnlyPath("/pairing")).toBe(false);
    expect(isLoopbackOnlyPath("/bridge/v1/snapshot")).toBe(false);
    // The device-facing POST /pair is prefixed and answers to anyone with a
    // code: it is how a phone gets a credential, not part of the desk surface.
    expect(isLoopbackOnlyPath("/bridge/v1/pair")).toBe(false);
  });
});
