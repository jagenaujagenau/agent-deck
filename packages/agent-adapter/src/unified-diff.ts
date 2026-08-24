type Op = { kind: "eq" | "del" | "ins"; text: string };

export type UnifiedDiffOptions = {
  /** Unchanged lines kept either side of a change. */
  context?: number;
  /** Give up past this edit distance and let the caller fall back to a coarse diff. */
  maxEdits?: number;
  /** Refuse inputs larger than this; Myers is O((N+M)D) and hooks run on the user's turn latency. */
  maxLines?: number;
};

/**
 * Renders `before` -> `after` as a unified diff with real `@@` line ranges, so the phone can show
 * true line numbers instead of a wall of `+`. Returns "" when nothing changed, and null when the
 * inputs are too large or too dissimilar to diff cheaply.
 */
export function unifiedDiff(before: string, after: string, options: UnifiedDiffOptions = {}): string | null {
  const context = options.context ?? 3;
  const maxEdits = options.maxEdits ?? 2_000;
  const maxLines = options.maxLines ?? 20_000;
  if (before === after) return "";

  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > maxLines || b.length > maxLines) return null;

  // Myers cost scales with the edit distance, so shave the identical head and tail first: an edit
  // deep inside a large file then costs about what the edited region alone costs.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;

  const middle = diffLines(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), maxEdits);
  if (!middle) return null;

  const ops: Op[] = [
    ...a.slice(0, prefix).map((text): Op => ({ kind: "eq", text })),
    ...middle,
    ...a.slice(a.length - suffix).map((text): Op => ({ kind: "eq", text })),
  ];
  return formatHunks(ops, context);
}

/** `"a\nb\n"` is two lines, not three; a trailing newline terminates the last one. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers shortest-edit-script. Returns null once the edit distance passes `maxEdits`. */
function diffLines(a: string[], b: string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((text) => ({ kind: "ins", text }));
  if (m === 0) return a.map((text) => ({ kind: "del", text }));

  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  let v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d, offset);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], d: number, offset: number): Op[] {
  const reversed: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let step = d; step > 0; step -= 1) {
    const v = trace[step];
    const k = x - y;
    const previousK = k === -step || (k !== step && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const previousX = v[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x -= 1; y -= 1; reversed.push({ kind: "eq", text: a[x] }); }
    if (x > previousX) { x -= 1; reversed.push({ kind: "del", text: a[x] }); }
    else if (y > previousY) { y -= 1; reversed.push({ kind: "ins", text: b[y] }); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; reversed.push({ kind: "eq", text: a[x] }); }
  while (x > 0) { x -= 1; reversed.push({ kind: "del", text: a[x] }); }
  while (y > 0) { y -= 1; reversed.push({ kind: "ins", text: b[y] }); }
  return reversed.reverse();
}

function formatHunks(ops: Op[], context: number): string {
  type Entry = Op & { oldLine: number; newLine: number };
  const entries: Entry[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    entries.push({ ...op, oldLine, newLine });
    if (op.kind !== "ins") oldLine += 1;
    if (op.kind !== "del") newLine += 1;
  }

  const changed = entries.flatMap((entry, index) => (entry.kind === "eq" ? [] : [index]));
  if (changed.length === 0) return "";

  // Two changes closer than 2x context share a hunk rather than repeating the lines between them.
  const groups: Array<[number, number]> = [];
  let start = changed[0];
  let end = changed[0];
  for (const index of changed.slice(1)) {
    if (index - end <= context * 2) end = index;
    else { groups.push([start, end]); start = index; end = index; }
  }
  groups.push([start, end]);

  const out: string[] = [];
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(entries.length - 1, last + context);
    const slice = entries.slice(from, to + 1);
    const oldCount = slice.filter((entry) => entry.kind !== "ins").length;
    const newCount = slice.filter((entry) => entry.kind !== "del").length;
    // A pure insertion sits *after* old line N, which unified format writes as position N with length 0.
    const oldStart = oldCount === 0 ? slice[0].oldLine - 1 : slice.find((entry) => entry.kind !== "ins")!.oldLine;
    const newStart = newCount === 0 ? slice[0].newLine - 1 : slice.find((entry) => entry.kind !== "del")!.newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const entry of slice) out.push(`${entry.kind === "del" ? "-" : entry.kind === "ins" ? "+" : " "}${entry.text}`);
  }
  return out.join("\n");
}
