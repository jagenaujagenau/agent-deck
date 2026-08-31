import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionStateDirectory, sessionStatePath } from "./session-paths";

const saved = process.env.AGENT_DECK_STATE_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_DECK_STATE_DIR;
  else process.env.AGENT_DECK_STATE_DIR = saved;
});

describe("session paths", () => {
  test("the override redirects every file of a session, not some of them", () => {
    process.env.AGENT_DECK_STATE_DIR = "/tmp/scratch-deck";
    expect(sessionStateDirectory()).toBe("/tmp/scratch-deck");
    expect(sessionStatePath("claude-abc")).toBe("/tmp/scratch-deck/claude-abc.json");
  });

  test("without an override a session lives under the user's cache", () => {
    delete process.env.AGENT_DECK_STATE_DIR;
    expect(sessionStatePath("claude-abc")).toBe(
      join(homedir(), ".cache", "agent-deck", "runtime-hooks", "claude-abc.json"),
    );
  });

  test("the socket and pid files derive from the state path, so they redirect with it", () => {
    process.env.AGENT_DECK_STATE_DIR = "/tmp/scratch-deck";
    const state = sessionStatePath("claude-abc");
    // The shim probes `${statePath}.sock` and the handler writes
    // `${statePath}.pid`; both follow the one derivation above.
    expect(`${state}.sock`).toStartWith("/tmp/scratch-deck/");
    expect(`${state}.pid`).toStartWith("/tmp/scratch-deck/");
  });
});
