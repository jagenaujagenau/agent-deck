import { describe, expect, it } from "bun:test"
import { bearerOf, routePolicy } from "./Auth.ts"

const AGENT = "01a02e7b-3852-794f-b871-543c3c9147e9"
const REQ = "req_123"

describe("routePolicy", () => {
  it("keeps device-reachable read paths open to paired devices", () => {
    // These are what the phone and watch call constantly. If any becomes
    // runtimeOnly, paired devices go blank.
    for (const path of [
      `/agents/${AGENT}/history`,
      `/agents/${AGENT}/changes`,
      "/snapshot",
      "/events",
      "/analytics"
    ]) {
      const policy = routePolicy("GET", path)
      expect({ path, ...policy }).toEqual({ path, runtimeOnly: false, requiredScope: "read" })
    }
  })

  it("reserves runtime ingestion for the runtime credential", () => {
    for (const [method, path] of [
      ["POST", "/agents/heartbeat"],
      ["POST", `/agents/${AGENT}/events`],
      ["POST", `/agents/${AGENT}/runtime-events`],
      ["GET", `/agents/${AGENT}/commands`],
      ["POST", `/agents/${AGENT}/commands/abc/ack`],
      ["GET", "/managed/runtimes"],
      ["POST", "/managed/claude/sessions"],
      // Polling a request outcome is how a blocked runtime collects its answer.
      ["GET", `/agents/${AGENT}/requests/${REQ}`],
      // Publishing a command catalog is the runtime describing itself.
      ["POST", `/agents/${AGENT}/slash-commands`]
    ] as Array<[string, string]>) {
      expect({ path, runtimeOnly: routePolicy(method, path).runtimeOnly })
        .toEqual({ path, runtimeOnly: true })
    }
  })

  it("lets a device read the command catalog it cannot publish", () => {
    expect(routePolicy("GET", `/agents/${AGENT}/slash-commands`))
      .toEqual({ runtimeOnly: false, requiredScope: "read" })
  })

  it("requires control scope for actions that steer an agent", () => {
    for (const path of [
      `/agents/${AGENT}/control`,
      `/agents/${AGENT}/requests/${REQ}/resolve`,
      `/managed/${AGENT}/requests/${REQ}/resolve`
    ]) {
      const policy = routePolicy("POST", path)
      expect({ path, ...policy }).toEqual({ path, runtimeOnly: false, requiredScope: "control" })
    }
  })
})

describe("bearerOf", () => {
  it("strips the scheme case-insensitively and tolerates absence", () => {
    expect(bearerOf("Bearer abc")).toBe("abc")
    expect(bearerOf("bearer abc")).toBe("abc")
    expect(bearerOf("abc")).toBe("abc")
    expect(bearerOf(undefined)).toBe("")
  })
})

describe("routePolicy is applied to the prefixed path", () => {
  // The deployed bridge matches against Hono's `c.req.path`, which still
  // carries the /bridge/v1 mount prefix. Its anchored rules therefore do not
  // fire in production, and this rewrite must not change that: tightening it
  // would lock paired phones out of endpoints they use today.
  const P = "/bridge/v1"

  it("leaves managed routes device-reachable, as deployed", () => {
    expect(routePolicy("GET", `${P}/managed/runtimes`).runtimeOnly).toBe(false)
    expect(routePolicy("POST", `${P}/managed/claude/sessions`).runtimeOnly).toBe(false)
  })

  it("leaves catalog publish and request polling device-reachable, as deployed", () => {
    expect(routePolicy("POST", `${P}/agents/${AGENT}/slash-commands`).runtimeOnly).toBe(false)
    expect(routePolicy("GET", `${P}/agents/${AGENT}/requests/${REQ}`).runtimeOnly).toBe(false)
  })

  it("still reserves runtime ingestion, whose rules are unanchored", () => {
    expect(routePolicy("POST", `${P}/agents/heartbeat`).runtimeOnly).toBe(true)
    expect(routePolicy("POST", `${P}/agents/${AGENT}/events`).runtimeOnly).toBe(true)
    expect(routePolicy("GET", `${P}/agents/${AGENT}/commands`).runtimeOnly).toBe(true)
  })

  it("still requires control scope for /control", () => {
    expect(routePolicy("POST", `${P}/agents/${AGENT}/control`).requiredScope).toBe("control")
  })
})
