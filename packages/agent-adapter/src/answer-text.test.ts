import { describe, expect, test } from "bun:test";
import { answerText } from "./index";

describe("answerText", () => {
  test("unwraps the question-keyed shape devices send", () => {
    expect(answerText({ "Which database?": "Postgres" })).toBe("Postgres");
  });

  test("passes a bare string through", () => {
    expect(answerText("Postgres")).toBe("Postgres");
  });

  test("keeps multi-answer payloads intact rather than picking one arbitrarily", () => {
    const value = { "Which database?": "Postgres", "Which region?": "eu-west" };
    expect(answerText(value)).toBe(JSON.stringify(value));
  });

  test("an unresolved request yields no answer", () => {
    expect(answerText(undefined)).toBeUndefined();
    expect(answerText(null)).toBeUndefined();
  });
});
