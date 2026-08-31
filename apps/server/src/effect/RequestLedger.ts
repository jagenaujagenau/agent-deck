import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import {
  parseUserInputRequest,
  type CanonicalRuntimeEvent,
  type RuntimeRequestStatus,
} from "@agent-control-dashboard/agent-adapter";
import type { JsonObject, JsonValue, PendingApproval } from "./Domain";

/**
 * The one owner of durable Requests (`bridge_requests`).
 *
 * Every rule of the Request lifecycle lives here and nowhere else: a request
 * opens pending and a terminal request can never be reopened by a late
 * delivery; expiry is settled on read, and settling it publishes the
 * canonical resolution fact — silence is what left the deck showing prompts
 * nobody could answer; a resolution is legal only for the kind that can
 * carry it (answers to questions, decisions to approvals), asked once,
 * answered once. Before this module those rules were written six times
 * across BridgeState and ManagedRuntime — two upserts whose conflict clauses
 * only stayed equivalent because every caller happened to insert `pending`,
 * and four copies of read-newest-expire-and-reduce.
 *
 * Built inside the BridgeState layer rather than as its own service: the
 * ledger publishes resolution facts through the event log and announces
 * changes, and those live in that layer's closure.
 */

export type RequestKind = "approval" | "user-input";

/** How a request settled, as the resolution fact carries it. */
type ResolutionPayload = { status: RuntimeRequestStatus; value?: JsonValue };

/** The newest live request of each kind for one session. */
type PendingRequests = { approval?: PendingApproval; question?: PendingQuestion };

/** A pending user-input question, as the snapshot renders it on a card. */
export interface PendingQuestion {
  id: string;
  question: string;
  options: ReadonlyArray<string>;
  createdAt: string;
  expiresAt: string;
}

/** What a stored request row holds: a runtime event's payload, or an approval. */
export type RequestData = PendingApproval | CanonicalRuntimeEvent["payload"];

const decodeString = Schema.decodeUnknownOption(Schema.String);

/** A pending approval request row, reduced to what a card renders. */
const toPendingApproval = (
  requestId: string,
  rawData: string,
  created_at: string,
  expires_at: string | null,
): PendingApproval | undefined => {
  let data: JsonObject;
  try {
    data = JSON.parse(rawData);
  } catch {
    return undefined;
  }
  const tool = decodeString(data.tool);
  const detail = decodeString(data.detail);
  if (Option.isNone(tool) || Option.isNone(detail)) return undefined;
  return {
    id: requestId,
    tool: tool.value,
    detail: detail.value,
    createdAt: Option.getOrElse(decodeString(data.createdAt), () => created_at),
    expiresAt: Option.getOrElse(
      decodeString(data.expiresAt),
      () => expires_at ?? new Date(Date.now() + 10 * 60_000).toISOString(),
    ),
  };
};

/**
 * A pending user-input request, reduced to what a card renders.
 *
 * The phrasing decode — flat `{ question, options }` from the hooks and Pi,
 * the SDK's `questions` array from the hosted runtime — lives in
 * `parseUserInputRequest`, shared with everything else that reads one.
 */
export const toPendingQuestion = (
  requestId: string,
  rawData: string,
  created_at: string,
  expires_at: string | null,
): PendingQuestion | undefined => {
  let data: JsonObject;
  try {
    data = JSON.parse(rawData);
  } catch {
    return undefined;
  }
  const parsed = parseUserInputRequest(data);
  if (parsed === undefined) return undefined;
  return {
    id: requestId,
    question: parsed.question,
    // Only a single-answer question maps onto a device's option list: a
    // multi-select offered as one-tap buttons records a choice nobody could
    // make. The question still shows; the answer belongs on the host.
    options: parsed.multiSelect ? [] : parsed.options,
    createdAt: Option.getOrElse(decodeString(data.createdAt), () => created_at),
    expiresAt: Option.getOrElse(
      decodeString(data.expiresAt),
      () => expires_at ?? new Date(Date.now() + 10 * 60_000).toISOString(),
    ),
  };
};

/**
 * The one shape an answer may take: the question's own text mapped to the
 * words chosen, which is what every runtime consumes. Anything else fed
 * through would reach a blocked runtime as garbage it cannot act on — and a
 * consumed request with a useless resolution leaves the real answer with
 * nothing left to answer. A decision carries no value at all: approve or
 * reject is the whole of it.
 */
export const resolutionFitsKind = (
  status: RuntimeRequestStatus,
  value: JsonValue | undefined,
): boolean => {
  if (status === "answered") {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === "string")
    );
  }
  return value === undefined;
};

const resolvedEventType = (kind: string): "request.resolved" | "user-input.resolved" =>
  kind === "user-input" ? "user-input.resolved" : "request.resolved";

export interface RequestLedgerDeps {
  sql: SqlClient.SqlClient;
  now: () => string;
  /** Appends the canonical resolution fact for a request this ledger settled. */
  recordResolution: (
    agentId: string,
    eventType: "request.resolved" | "user-input.resolved",
    requestId: string,
    payload: ResolutionPayload,
  ) => Effect.Effect<void>;
  /** Announces that the deck changed. */
  changed: Effect.Effect<void>;
}

export type RequestLedger = ReturnType<typeof makeRequestLedger>;

export function makeRequestLedger(deps: RequestLedgerDeps) {
  const { sql, now } = deps;

  /** Opens (or refreshes) a pending request; a terminal request stays terminal. */
  const open = (
    agentId: string,
    requestId: string,
    kind: RequestKind,
    data: RequestData,
    createdAt: string,
    expiresAt?: string,
  ) =>
    sql`INSERT INTO bridge_requests (request_id, agent_id, kind, status, data, created_at, expires_at, resolved_at)
        VALUES (${requestId}, ${agentId}, ${kind}, 'pending', ${JSON.stringify(data)}, ${createdAt},
                ${expiresAt ?? null}, NULL)
        ON CONFLICT(request_id) DO UPDATE SET agent_id = excluded.agent_id, kind = excluded.kind,
          data = excluded.data, expires_at = excluded.expires_at`.pipe(Effect.orDie, Effect.asVoid);

  /** Writes a terminal status without publishing; a settled row never moves again. */
  const setStatus = Effect.fn("RequestLedger.setStatus")(function* (
    requestId: string,
    status: RuntimeRequestStatus,
    value?: JsonValue,
  ) {
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM bridge_requests WHERE request_id = ${requestId}`;
    let data: JsonObject = {};
    try {
      if (rows[0]) data = JSON.parse(rows[0].data);
    } catch {
      /* Preserve an empty payload. */
    }
    if (value !== undefined) data.resolutionValue = value;
    yield* sql`UPDATE bridge_requests SET status = ${status}, data = ${JSON.stringify(data)}, resolved_at = ${now()}
               WHERE request_id = ${requestId} AND status = 'pending'`;
  }, Effect.orDie);

  /** Settles an expired row and says so on the event log, like any resolution. */
  const expire = (agentId: string, kind: string, requestId: string) =>
    Effect.gen(function* () {
      yield* setStatus(requestId, "expired");
      yield* deps.recordResolution(agentId, resolvedEventType(kind), requestId, {
        status: "expired",
      });
      yield* deps.changed;
    });

  /**
   * Whether this resolution is legal: the request is still pending, the
   * status fits the kind — answers settle questions, decisions settle
   * approvals, never the other way around — and the value fits the status.
   * A resolution that does not fit is refused whole and the request stays
   * pending, because consent or an answer the bridge invented is neither.
   */
  const canResolve = Effect.fn("RequestLedger.canResolve")(function* (
    agentId: string,
    requestId: string,
    status: RuntimeRequestStatus,
    value?: JsonValue,
  ) {
    const rows = yield* sql<{ kind: string; status: string }>`
      SELECT kind, status FROM bridge_requests WHERE request_id = ${requestId} AND agent_id = ${agentId}`;
    const row = rows[0];
    return (
      row?.status === "pending" &&
      (status !== "answered" || row.kind === "user-input") &&
      (!["approved", "rejected"].includes(status) || row.kind === "approval") &&
      resolutionFitsKind(status, value)
    );
  }, Effect.orDie);

  /** Resolves a pending request exactly once, publishing the fact. */
  const resolve = Effect.fn("RequestLedger.resolve")(function* (
    agentId: string,
    requestId: string,
    status: RuntimeRequestStatus,
    value?: JsonValue,
  ) {
    if (!(yield* canResolve(agentId, requestId, status, value))) return false;
    const rows = yield* sql<{ kind: string }>`
      SELECT kind FROM bridge_requests WHERE request_id = ${requestId}`.pipe(Effect.orDie);
    yield* setStatus(requestId, status, value);
    // The projector reading this back treats a present-but-undefined
    // `value` key differently from an absent one, so the key only exists
    // when a value was actually supplied.
    const payload: ResolutionPayload = { status };
    if (value !== undefined) payload.value = value;
    yield* deps.recordResolution(
      agentId,
      resolvedEventType(rows[0]?.kind ?? "approval"),
      requestId,
      payload,
    );
    yield* deps.changed;
    return true;
  });

  /**
   * The request's current standing — still pending, or how it settled. A
   * pending row past its expiry is settled here, resolution fact included,
   * before being reported. Scoped to an agent when the caller knows one.
   */
  const status = Effect.fn("RequestLedger.status")(function* (requestId: string, agentId?: string) {
    const rows = yield* sql<{
      agent_id: string;
      kind: string;
      status: RuntimeRequestStatus;
      data: string;
      expires_at: string | null;
    }>`SELECT agent_id, kind, status, data, expires_at FROM bridge_requests
       WHERE request_id = ${requestId}`;
    const row = rows[0];
    if (row === undefined || (agentId !== undefined && row.agent_id !== agentId)) return undefined;
    if (row.status === "pending" && row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      yield* expire(row.agent_id, row.kind, requestId);
      const expired: RuntimeRequestStatus = "expired";
      return { status: expired };
    }
    let data: JsonObject = {};
    try {
      data = JSON.parse(row.data);
    } catch {
      /* No resolution value. */
    }
    return { status: row.status, value: data.resolutionValue };
  }, Effect.orDie);

  const newestPendingRow = (agentId: string, kind: RequestKind) =>
    sql<{
      request_id: string;
      data: string;
      created_at: string;
      expires_at: string | null;
    }>`SELECT request_id, data, created_at, expires_at FROM bridge_requests
       WHERE agent_id = ${agentId} AND kind = ${kind} AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`;

  /** The newest live request of each kind, expiring what it finds dead on the way. */
  const pendingFor = Effect.fn("RequestLedger.pendingFor")(function* (agentId: string) {
    const result: PendingRequests = {};
    for (const kind of ["approval", "user-input"] as const) {
      const row = (yield* newestPendingRow(agentId, kind))[0];
      if (row === undefined) continue;
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        yield* expire(agentId, kind, row.request_id);
        continue;
      }
      if (kind === "approval") {
        result.approval = toPendingApproval(
          row.request_id,
          row.data,
          row.created_at,
          row.expires_at,
        );
      } else {
        result.question = toPendingQuestion(
          row.request_id,
          row.data,
          row.created_at,
          row.expires_at,
        );
      }
    }
    return result;
  }, Effect.orDie);

  /**
   * Every live request keyed by agent, in one query. The snapshot reads this
   * once per revision instead of once per agent, so a deck of N sessions is
   * one `SELECT` rather than N.
   */
  const pendingByAgent = Effect.fn("RequestLedger.pendingByAgent")(function* () {
    const rows = yield* sql<{
      agent_id: string;
      request_id: string;
      kind: string;
      data: string;
      created_at: string;
      expires_at: string | null;
    }>`SELECT agent_id, request_id, kind, data, created_at, expires_at FROM bridge_requests
       WHERE status = 'pending'
       ORDER BY created_at DESC`.pipe(Effect.orDie);
    const approvals = new Map<string, PendingApproval>();
    const questions = new Map<string, PendingQuestion>();
    const seen = new Set<string>();
    for (const row of rows) {
      // Latest per agent and kind wins; the rest are stale duplicates.
      const key = `${row.agent_id}\u0000${row.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        yield* expire(row.agent_id, row.kind, row.request_id);
        continue;
      }
      if (row.kind === "approval") {
        const approval = toPendingApproval(
          row.request_id,
          row.data,
          row.created_at,
          row.expires_at,
        );
        if (approval) approvals.set(row.agent_id, approval);
      } else {
        const question = toPendingQuestion(
          row.request_id,
          row.data,
          row.created_at,
          row.expires_at,
        );
        if (question) questions.set(row.agent_id, question);
      }
    }
    return { approvals, questions };
  }, Effect.orDie);

  /** Which session a request belongs to — the one lookup a resolver by id needs. */
  const agentFor = Effect.fn("RequestLedger.agentFor")(function* (requestId: string) {
    const rows = yield* sql<{
      agent_id: string;
    }>`SELECT agent_id FROM bridge_requests WHERE request_id = ${requestId}`;
    return rows[0]?.agent_id;
  }, Effect.orDie);

  return { open, setStatus, canResolve, resolve, status, pendingFor, pendingByAgent, agentFor };
}
