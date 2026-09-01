/**
 * Holding a hook open while the deck decides.
 *
 * A blocked hook is a stopped process. Nothing else heartbeats for that
 * session, and a session that stops heartbeating goes offline on every
 * surface — so the deck would show the person as unreachable in the one
 * moment it is waiting on them to answer. The wait therefore carries its own
 * pulse.
 *
 * That pulse must die with the wait on every path, including a throw. It used
 * to be four hand-maintained `clearInterval` calls across two nearly
 * identical lifecycles — an approval and a question — where forgetting one
 * would leave a finished session heartbeating forever, which is to say alive
 * on the deck and answering nothing.
 */

/** How often a blocked hook says it is still there. */
export const BLOCKED_BEAT_MS = 10_000;

export const whileBlocked = async <A>(
  heartbeat: () => Promise<void>,
  body: () => Promise<A>,
  beatEveryMs: number = BLOCKED_BEAT_MS,
): Promise<A> => {
  await heartbeat();
  const pulse = setInterval(() => void heartbeat().catch(() => {}), beatEveryMs);
  try {
    return await body();
  } finally {
    clearInterval(pulse);
  }
};
