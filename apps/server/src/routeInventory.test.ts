import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeRoutePaths } from "./effect/Http";

/**
 * Every route the bridge serves, held to the promises the repository makes
 * about it.
 *
 * The wire contract is a document (`docs/bridge-api.md`) and an SDK
 * (`packages/bridge-client`) and an executed suite (`contract.test.ts`), and
 * a route can be added to the router without touching any of the three. That
 * is how the pairing page group came to be undocumented and how `/queued`
 * came to be documented but unreachable through the SDK — nothing failed,
 * so nobody saw. The inventory is read from the router itself, so it cannot
 * drift; what this suite adds is the requirement that each route is either
 * covered or *knowingly* uncovered, named here with the reason.
 */

const root = join(import.meta.dir, "..", "..", "..");
const doc = readFileSync(join(root, "docs", "bridge-api.md"), "utf8");

/** The path as the document writes it: `:id` and `:agentId` are the same parameter to a reader. */
const documented = (path: string): boolean => {
  const candidates = new Set([
    path,
    path.replace("/bridge/v1", ""),
    path.replace(/:agentId/g, ":id"),
    path.replace("/bridge/v1", "").replace(/:agentId/g, ":id"),
    path.replace(/:commandId/g, ":id"),
    path.replace("/bridge/v1", "").replace(/:commandId/g, ":id"),
  ]);
  return [...candidates].some((candidate) => doc.includes(candidate));
};

/**
 * Routes the document deliberately does not describe, and why. A route named
 * here is a decision; a route named nowhere is an omission.
 */
const UNDOCUMENTED_ON_PURPOSE = {
  "GET /pair": "the desk-only pairing page — a person's surface, not a wire contract",
  "POST /pair/code": "desk-only, serves the pairing page",
  "GET /pair/devices": "desk-only, serves the pairing page",
  "DELETE /pair/devices/:deviceId": "desk-only, serves the pairing page",
  "GET /": "liveness, described under Conventions rather than as a route",
} satisfies Record<string, string>;

describe("the route inventory", () => {
  test("every route is documented, or knowingly is not", () => {
    const missing = bridgeRoutePaths().filter((route) => {
      if (route in UNDOCUMENTED_ON_PURPOSE) return false;
      const path = route.slice(route.indexOf(" ") + 1);
      return !documented(path);
    });
    expect(missing).toEqual([]);
  });

  test("the exemption list names only routes that exist", () => {
    const served = new Set(bridgeRoutePaths());
    const stale = Object.keys(UNDOCUMENTED_ON_PURPOSE).filter((route) => !served.has(route));
    // An exemption for a route that no longer exists is an exemption nobody
    // is reading — and the next reader would trust it.
    expect(stale).toEqual([]);
  });

  test("the inventory is the router's own, not a second list to maintain", () => {
    // If these ever disagree the inventory has become decoration; it is
    // derived from the same array the router is built from.
    expect(bridgeRoutePaths().length).toBeGreaterThan(25);
    expect(new Set(bridgeRoutePaths()).size).toBe(bridgeRoutePaths().length);
  });
});
