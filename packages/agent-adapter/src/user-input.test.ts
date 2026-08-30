import { describe, expect, test } from "bun:test";
import { parseUserInputRequest } from "./user-input";

describe("parseUserInputRequest", () => {
  test("reads the flat phrasing the hooks, Pi, and herdr publish", () => {
    expect(
      parseUserInputRequest({ question: "Resume from summary?", options: ["Yes", "No"] }),
    ).toEqual({ question: "Resume from summary?", options: ["Yes", "No"], multiSelect: false });
  });

  test("reads the SDK's questions array, labelled options and all", () => {
    expect(
      parseUserInputRequest({
        questions: [{ question: "Which file?", options: [{ label: "a.ts" }, { label: "b.ts" }] }],
      }),
    ).toEqual({ question: "Which file?", options: ["a.ts", "b.ts"], multiSelect: false });
  });

  test("prompt and header are the question's fallbacks, in that order", () => {
    expect(parseUserInputRequest({ questions: [{ prompt: "Pick one" }] })?.question).toBe(
      "Pick one",
    );
    expect(parseUserInputRequest({ questions: [{ header: "Choose" }] })?.question).toBe("Choose");
    expect(parseUserInputRequest({ header: "Inline header" })?.question).toBe("Inline header");
  });

  test("a multi-select cannot be answered by one tap, and says so", () => {
    expect(
      parseUserInputRequest({
        questions: [{ question: "Keep which?", multiSelect: true, options: [{ label: "x" }] }],
      })?.multiSelect,
    ).toBe(true);
    // Several questions at once are just as unanswerable by a single choice.
    expect(
      parseUserInputRequest({
        questions: [{ question: "First?" }, { question: "Second?" }],
      })?.multiSelect,
    ).toBe(true);
  });

  test("an option that is its own label still counts; a labelless object does not", () => {
    expect(
      parseUserInputRequest({ question: "N?", options: ["1", 2, true, { note: "x" }] }),
    ).toEqual({ question: "N?", options: ["1", "2", "true"], multiSelect: false });
  });

  test("a payload with no readable question is no question", () => {
    expect(parseUserInputRequest({})).toBeUndefined();
    expect(parseUserInputRequest({ question: "  " })).toBeUndefined();
    expect(parseUserInputRequest({ questions: [] })).toBeUndefined();
  });
});
