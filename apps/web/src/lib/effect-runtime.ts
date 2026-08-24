import { Effect } from 'effect';

/**
 * Effect runtime configuration
 * Provides a way to run Effect programs in React components
 */

export const runEffect = <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> => {
  return Effect.runPromise(effect);
};

export const runEffectSync = <A, E>(effect: Effect.Effect<A, E>): A => {
  return Effect.runSync(effect);
};
