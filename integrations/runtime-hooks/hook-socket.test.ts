import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callHookSocket,
  serveHookSocket,
  type SocketHookRequest,
  type SocketHookResponse,
} from "./hook-socket";

let directory: string;
let server: { close(): void } | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function serve(handle: (request: SocketHookRequest) => Promise<SocketHookResponse>): string {
  directory = mkdtempSync(join(tmpdir(), "agent-deck-hook-socket-"));
  const socketPath = join(directory, "state.json.sock");
  server = serveHookSocket(socketPath, handle);
  return socketPath;
}

const request = (payload: string): SocketHookRequest => ({
  runtime: "claude",
  expectedEvent: "PostToolUse",
  payload,
  cwd: "/tmp",
  ppid: 1,
});

describe("hook socket", () => {
  test("round trips one request to one response", async () => {
    const seen: SocketHookRequest[] = [];
    const socketPath = serve(async (incoming) => {
      seen.push(incoming);
      return { stdout: "decision", exitCode: 0 };
    });
    const reply = await callHookSocket(socketPath, request('{"tool_name":"Read"}'));
    expect(reply).toEqual({ stdout: "decision", exitCode: 0 });
    // The payload crosses as the verbatim stdin text, not a re-serialisation.
    expect(seen[0]?.payload).toBe('{"tool_name":"Read"}');
    expect(seen[0]?.ppid).toBe(1);
  });

  test("serves requests one at a time, in arrival order", async () => {
    const order: string[] = [];
    const socketPath = serve(async (incoming) => {
      order.push(`start:${incoming.payload}`);
      if (incoming.payload === "a") await Bun.sleep(50);
      order.push(`end:${incoming.payload}`);
      return {};
    });
    const first = callHookSocket(socketPath, request("a"));
    await Bun.sleep(10);
    const second = callHookSocket(socketPath, request("b"));
    await Promise.all([first, second]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("a missing socket answers undefined, not an error", async () => {
    directory = mkdtempSync(join(tmpdir(), "agent-deck-hook-socket-"));
    const reply = await callHookSocket(join(directory, "absent.sock"), request("{}"));
    expect(reply).toBeUndefined();
  });

  test("a throwing handler answers an error the caller can fall back on", async () => {
    const socketPath = serve(async () => {
      throw new Error("state file locked");
    });
    const reply = await callHookSocket(socketPath, request("{}"));
    expect(reply?.error).toContain("state file locked");
  });

  test("an unreadable request line is answered, never crashes the daemon", async () => {
    const socketPath = serve(async () => ({ stdout: "unreached" }));
    const line = await new Promise<string>((resolve) => {
      const socket = connect(socketPath, () => socket.write("not json\n"));
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        if (buffer.includes("\n")) {
          socket.destroy();
          resolve(buffer);
        }
      });
    });
    expect(JSON.parse(line)).toEqual({ error: "unreadable request" });
    // The server survives to serve the next, well-formed request.
    expect(await callHookSocket(socketPath, request("{}"))).toEqual({ stdout: "unreached" });
  });

  test("the shim reaches the daemon of the session its payload names", async () => {
    // End to end through the real entry: index.ts must derive the same socket
    // path from the payload that the daemon derives from its state path.
    // Rooted at /tmp, not tmpdir(): macOS caps a unix socket path at 104
    // bytes, and the darwin tmpdir plus the state-directory suffix exceeds it.
    directory = mkdtempSync("/tmp/agent-deck-shim-");
    const stateDirectory = join(directory, ".cache", "agent-deck", "runtime-hooks");
    mkdirSync(stateDirectory, { recursive: true });
    const sessionKey = createHash("sha256").update("shim-session").digest("hex").slice(0, 24);
    const statePath = join(stateDirectory, `claude-${sessionKey}.json`);
    let served: SocketHookRequest | undefined;
    server = serveHookSocket(`${statePath}.sock`, async (incoming) => {
      served = incoming;
      return { stdout: '{"decision":"block"}', exitCode: 0 };
    });
    const payload = JSON.stringify({ session_id: "shim-session", hook_event_name: "Stop" });
    const shim = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts"), "claude", "Stop"],
      {
        // The dead bridge URL is a tripwire: if the shim ever misses the socket
        // and falls back, its publishes go nowhere instead of to a real deck.
        env: { ...process.env, HOME: directory, AGENT_DECK_URL: "http://127.0.0.1:9" },
        stdin: new TextEncoder().encode(payload),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(shim.stdout).text();
    expect(await shim.exited).toBe(0);
    expect(stdout.trim()).toBe('{"decision":"block"}');
    expect(served?.payload).toBe(payload);
    expect(served?.expectedEvent).toBe("Stop");
  });
});
