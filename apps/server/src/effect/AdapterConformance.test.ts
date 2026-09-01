import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFORMANCE_CORPUS_PATH,
  conformanceFailures,
  playScenario,
  projectionFields,
  readConformanceCorpus,
} from "./AdapterConformance";

const corpus = readConformanceCorpus(
  readFileSync(join(import.meta.dir, "../../../..", CONFORMANCE_CORPUS_PATH), "utf8"),
);

/**
 * The corpus, played against the projector and the stale guard the bridge
 * ships. `scripts/conformance.ts` plays the same file over HTTP, so a harness
 * author outside this repository can hold their adapter to what these tests
 * hold ours to.
 */
describe("the adapter conformance corpus", () => {
  test("holds scenarios", () => {
    expect(corpus.scenarios.length).toBeGreaterThan(10);
  });

  test("says why each rule exists, because the rule is the point and not the shape", () => {
    for (const scenario of corpus.scenarios) {
      expect(scenario.why.length).toBeGreaterThan(20);
    }
  });

  for (const scenario of corpus.scenarios) {
    test(scenario.case, () => {
      const played = playScenario(scenario, corpus.agentId);
      const failures = conformanceFailures(
        scenario,
        projectionFields(played.projection),
        played.accepted,
      );
      expect(failures).toEqual([]);
    });
  }
});
