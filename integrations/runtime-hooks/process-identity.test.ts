import { describe, expect, test } from "bun:test";
import { ownerAlive, processStart } from "./process-identity";

describe("processStart", () => {
  test("reads a start marker for a live process", () => {
    expect(processStart(process.pid)).toBeTruthy();
  });

  test("a pid nothing runs under has no start", async () => {
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    expect(processStart(gone.pid)).toBeUndefined();
  });
});

describe("ownerAlive", () => {
  test("no pid means this process owns the session", () => {
    expect(ownerAlive(undefined, undefined)).toBe(true);
    expect(ownerAlive(process.pid)).toBe(true);
  });

  test("a live owner with its own start marker is alive", () => {
    const parent = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(process.pid)]);
    const pid = Number(parent.stdout.toString().trim());
    expect(ownerAlive(pid, processStart(pid))).toBe(true);
  });

  test("a recycled pid is not the owner: same slot, different start", () => {
    const parent = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(process.pid)]);
    const pid = Number(parent.stdout.toString().trim());
    expect(ownerAlive(pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
  });

  test("a dead pid is dead regardless of marker", async () => {
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    expect(ownerAlive(gone.pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
  });

  test("a marker-less state file keeps the old pid-only behaviour", () => {
    const parent = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(process.pid)]);
    const pid = Number(parent.stdout.toString().trim());
    expect(ownerAlive(pid, undefined)).toBe(true);
  });
});
