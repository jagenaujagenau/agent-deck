import { describe, expect, test } from "bun:test";
import { askedQuestion, isAskUserQuestionTool } from "./questions";

describe("isAskUserQuestionTool", () => {
  test.each(["AskUserQuestion", "ask_user_question", "ask-user-question"])(
    "recognises %s",
    (name) => {
      expect(isAskUserQuestionTool(name)).toBe(true);
    },
  );

  test("does not claim unrelated tools", () => {
    expect(isAskUserQuestionTool("Bash")).toBe(false);
    expect(isAskUserQuestionTool("AskDocs")).toBe(false);
  });
});

describe("askedQuestion", () => {
  test("reads a question from the questions array", () => {
    expect(
      askedQuestion({
        questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }],
      }),
    ).toEqual({ question: "Ship it?", options: ["Yes", "No"] });
  });

  test("reads a question given inline on the call", () => {
    expect(askedQuestion({ question: "Ship it?", options: ["Yes"] })).toEqual({
      question: "Ship it?",
      options: ["Yes"],
    });
  });

  test("falls back to the header when there is no question text", () => {
    expect(askedQuestion({ questions: [{ header: "Deploy" }] }).question).toBe("Deploy");
  });

  test("an open question has no options, which is what sends it to the terminal", () => {
    expect(askedQuestion({ questions: [{ question: "What next?" }] }).options).toEqual([]);
  });

  test("unlabelled options are dropped rather than shown as blanks", () => {
    expect(
      askedQuestion({ question: "q", options: [{ label: "" }, { label: "Go" }] }).options,
    ).toEqual(["Go"]);
  });

  test("a call carrying nothing usable still names itself", () => {
    expect(askedQuestion({})).toEqual({ question: "Agent needs your answer", options: [] });
  });
});
