import { describe, expect, test } from "bun:test";
import { toPendingQuestion } from "./State";

describe("toPendingQuestion", () => {
  test("reads the flat hook/pi shape", () => {
    const question = toPendingQuestion(
      "req-1",
      JSON.stringify({
        kind: "user-input",
        question: "Which branch?",
        options: ["main", "dev"],
        createdAt: "2026-08-26T00:00:00.000Z",
        expiresAt: "2026-08-26T00:10:00.000Z",
      }),
      "2026-08-26T00:00:00.000Z",
      "2026-08-26T00:10:00.000Z",
    );
    expect(question).toEqual({
      id: "req-1",
      question: "Which branch?",
      options: ["main", "dev"],
      createdAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-08-26T00:10:00.000Z",
    });
  });

  test("reads the hosted SDK questions-array shape", () => {
    const question = toPendingQuestion(
      "req-2",
      JSON.stringify({
        kind: "user-input",
        questions: [
          {
            question: "Ship it?",
            options: [{ label: "Yes" }, { label: "No", description: "skip" }],
          },
        ],
      }),
      "2026-08-26T00:00:00.000Z",
      "2026-08-26T00:10:00.000Z",
    );
    expect(question?.question).toBe("Ship it?");
    expect(question?.options).toEqual(["Yes", "No"]);
    expect(question?.id).toBe("req-2");
  });

  test("prefers the flat question over the SDK array", () => {
    const question = toPendingQuestion(
      "req-3",
      JSON.stringify({
        question: "flat wins",
        questions: [{ question: "sdk loses" }],
      }),
      "2026-08-26T00:00:00.000Z",
      null,
    );
    expect(question?.question).toBe("flat wins");
  });

  test("returns undefined when there is no question text", () => {
    expect(
      toPendingQuestion(
        "req-4",
        JSON.stringify({ kind: "user-input" }),
        "2026-08-26T00:00:00.000Z",
        null,
      ),
    ).toBeUndefined();
  });

  test("falls back to the row's created_at and a default expiry", () => {
    const question = toPendingQuestion(
      "req-5",
      JSON.stringify({ question: "Only a question" }),
      "2026-08-26T00:00:00.000Z",
      null,
    );
    expect(question?.createdAt).toBe("2026-08-26T00:00:00.000Z");
    expect(question?.expiresAt).not.toBe("");
  });
});
