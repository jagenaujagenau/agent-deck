/**
 * A pid names a slot, not a process.
 *
 * The kernel reuses pids, so "is pid N alive" answers a different question
 * than "is the runtime that owned this session alive" — a recycled pid keeps
 * a dead session reporting forever, because `kill -0` happily greets whatever
 * moved in. The process start time is the marker that makes a pid mean one
 * process: the pair survives everything except the same pid starting at the
 * same second, which is not a coincidence the kernel produces.
 */

/** When the process running under this pid started, or nothing readable. */
export function processStart(pid: number): string | undefined {
  const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
  const line = result.stdout.toString().trim();
  return line || undefined;
}

/**
 * Whether the process that owned a session is still the one under its pid.
 *
 * No pid means this process owns the session; a missing marker means an older
 * state file wrote before markers existed, and its pid check keeps the old
 * behaviour. An unreadable current start must not kill a live session — `ps`
 * failing is an observation problem, not a death certificate.
 */
export function ownerAlive(pid?: number, start?: string): boolean {
  if (!pid || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (start === undefined) return true;
  const current = processStart(pid);
  return current === undefined || current === start;
}
