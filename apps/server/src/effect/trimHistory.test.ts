import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "./Domain";
import { trimHistory } from "./Store";

const at = (index: number) =>
  `2026-08-28T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;

const event = (id: string, index: number, command?: string): AgentEvent => ({
  id,
  kind: command ? "tool" : "output",
  summary: command ? "Bash" : "Response",
  command,
  createdAt: at(index),
});

const build = (words: number, commands: number) => {
  const ordered: AgentEvent[] = [];
  const spoken = new Set<string>();
  const total = words + commands;
  let placed = 0;
  for (let index = 0; index < total; index += 1) {
    // Spread words evenly through the timeline so both streams span it.
    const wanted = Math.round(((index + 1) * words) / total);
    if (placed < wanted) {
      const item = event(`word-${index}`, index);
      ordered.push(item);
      spoken.add(item.id);
      placed += 1;
    } else {
      ordered.push(event(`cmd-${index}`, index, "ls"));
    }
  }
  return { ordered, spoken };
};

describe("trimHistory", () => {
  test("under the limit nothing is trimmed", () => {
    const { ordered, spoken } = build(10, 10);
    expect(trimHistory(ordered, spoken, 100)).toHaveLength(20);
  });

  test("a chatty session still gets its terminal: activity keeps a third", () => {
    // Conversation alone exceeds the limit - the case that shipped an empty
    // terminal tab: every command was trimmed to make room for words.
    const { ordered, spoken } = build(400, 200);
    const kept = trimHistory(ordered, spoken, 300);
    expect(kept).toHaveLength(300);
    expect(kept.filter((e) => e.command).length).toBe(100);
    expect(kept.filter((e) => !e.command).length).toBe(200);
  });

  test("a quiet conversation spills its unused share to activity", () => {
    const { ordered, spoken } = build(20, 600);
    const kept = trimHistory(ordered, spoken, 300);
    expect(kept).toHaveLength(300);
    expect(kept.filter((e) => !e.command).length).toBe(20);
    expect(kept.filter((e) => e.command).length).toBe(280);
  });

  test("sparse activity spills its unused share back to words", () => {
    const { ordered, spoken } = build(600, 20);
    const kept = trimHistory(ordered, spoken, 300);
    expect(kept).toHaveLength(300);
    expect(kept.filter((e) => e.command).length).toBe(20);
    expect(kept.filter((e) => !e.command).length).toBe(280);
  });

  test("both sides keep their newest events", () => {
    const { ordered, spoken } = build(400, 200);
    const kept = trimHistory(ordered, spoken, 300);
    const newest = ordered[ordered.length - 1]!;
    expect(kept.some((e) => e.id === newest.id)).toBe(true);
  });
});
