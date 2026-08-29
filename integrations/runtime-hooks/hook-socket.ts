/**
 * The unix-socket lane between a hook invocation and its session daemon.
 *
 * A hook process paying bun startup plus this package's module graph on every
 * lifecycle event is what cost 120-290ms per tool call. The daemon already
 * lives for the whole session, so it serves the events instead: the shim
 * writes one JSON line down `${statePath}.sock` and prints whatever comes
 * back. This module is both ends of that wire, and it stays import-light
 * because the shim loads it before deciding whether the full handler is
 * needed at all.
 *
 * Protocol: one JSON line request, one JSON line response, then the daemon
 * closes. A blocking flow — an approval, a Stop delivery — simply holds the
 * connection open until the decision resolves; the shim waits on the socket
 * with no read deadline, exactly as the old in-process wait did.
 */

import { unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { asString, isJsonNumber, isJsonObject, parseJson } from "./json-value";

export type SocketHookRequest = {
  runtime: string;
  expectedEvent: string;
  /** The hook's stdin, verbatim; the daemon parses it. */
  payload: string;
  /** The hook process's cwd — the fallback when the payload names none. */
  cwd: string;
  /** The hook process's parent pid, where the runtime-owner walk starts. */
  ppid: number;
};

export type SocketHookResponse = {
  stdout?: string;
  exitCode?: number;
  /** Set when the daemon could not serve the event; the shim handles it locally instead. */
  error?: string;
};

/** The daemon-side listener; closing it also removes the socket file. */
export type HookSocketServer = { close(): void };

function parseRequestLine(line: string): SocketHookRequest | undefined {
  let value;
  try {
    value = parseJson(line);
  } catch {
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  const runtime = asString(value.runtime);
  const expectedEvent = asString(value.expectedEvent);
  const payload = asString(value.payload);
  const cwd = asString(value.cwd);
  const ppid = value.ppid;
  if (
    runtime === undefined ||
    expectedEvent === undefined ||
    payload === undefined ||
    cwd === undefined ||
    !isJsonNumber(ppid)
  ) {
    return undefined;
  }
  return { runtime, expectedEvent, payload, cwd, ppid };
}

function parseResponseLine(line: string): SocketHookResponse | undefined {
  let value;
  try {
    value = parseJson(line);
  } catch {
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  const response: SocketHookResponse = {};
  const stdout = asString(value.stdout);
  const error = asString(value.error);
  if (stdout !== undefined) response.stdout = stdout;
  if (error !== undefined) response.error = error;
  if (isJsonNumber(value.exitCode)) response.exitCode = value.exitCode;
  return response;
}

/**
 * Listens for hook events on the daemon's socket. Requests are served one at
 * a time in arrival order: handlers share the session state file, which has
 * no locking — the same reason the runtime never runs two hooks for one
 * session concurrently.
 */
export function serveHookSocket(
  socketPath: string,
  handle: (request: SocketHookRequest) => Promise<SocketHookResponse>,
): HookSocketServer {
  try {
    // A previous daemon that died uncleanly leaves its socket behind; the
    // path is derived from the state path, so reclaiming it is safe.
    unlinkSync(socketPath);
  } catch {
    /* No stale socket to clear. */
  }
  let queue: Promise<void> = Promise.resolve();
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let served = false;
    socket.on("error", () => {
      /* A client that vanished mid-request falls back on its own. */
    });
    socket.on("data", (chunk) => {
      if (served) return;
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      served = true;
      const request = parseRequestLine(buffer.slice(0, newline));
      queue = queue.then(async () => {
        const response: SocketHookResponse =
          request === undefined
            ? { error: "unreadable request" }
            : await handle(request).catch((cause) => ({ error: String(cause) }));
        socket.write(`${JSON.stringify(response)}\n`);
        socket.end();
      });
    });
  });
  // A socket that cannot be claimed — sun_path too long, permissions — must
  // not take the daemon down with it; every hook simply falls back to local
  // handling, which is the pre-socket behavior.
  server.on("error", () => {});
  server.listen(socketPath);
  return {
    close: () => {
      server.close();
      try {
        unlinkSync(socketPath);
      } catch {
        /* Already gone. */
      }
    },
  };
}

/**
 * Hands one hook event to the daemon and waits for its answer. `undefined`
 * means nobody served it — no socket, nothing listening, or an unreadable
 * reply — and the caller does the work itself. Only connecting is deadlined:
 * once the daemon has the event it may legitimately hold the reply for
 * minutes, an approval waiting on a phone being the canonical case.
 */
export function callHookSocket(
  socketPath: string,
  request: SocketHookRequest,
  connectTimeoutMs = 1_000,
): Promise<SocketHookResponse | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (response: SocketHookResponse | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      resolve(response);
    };
    const connectTimer = setTimeout(() => finish(undefined), connectTimeoutMs);
    socket.on("connect", () => {
      clearTimeout(connectTimer);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(parseResponseLine(buffer.slice(0, newline)));
    });
    socket.on("error", () => finish(undefined));
    socket.on("close", () => finish(undefined));
  });
}
