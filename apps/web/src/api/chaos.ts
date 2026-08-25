import { Effect } from "effect";

export class AgentNotFoundError {
  readonly _tag = "AgentNotFoundError";
  constructor(readonly agentId: string) {}
}

export class TaskNotFoundError {
  readonly _tag = "TaskNotFoundError";
  constructor(readonly taskId: string) {}
}

export class RunNotFoundError {
  readonly _tag = "RunNotFoundError";
  constructor(readonly runId: string) {}
}

export class ApiFailureError {
  readonly _tag = "ApiFailureError";
  constructor(readonly message: string) {}
}

export type ApiError = AgentNotFoundError | TaskNotFoundError | RunNotFoundError | ApiFailureError;

/**
 * Simulates a potential failure based on chaos settings
 * @param failureRate - Probability of failure (0-1)
 * @param message - Error message if failure occurs
 */
export const maybeFail = (
  failureRate: number,
  message = "Simulated API failure",
): Effect.Effect<void, ApiFailureError> =>
  Effect.gen(function* () {
    if (Math.random() < failureRate) {
      return yield* Effect.fail(new ApiFailureError(message));
    }
  });

/**
 * Simulates network delay
 */
export const simulateDelay = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`);
