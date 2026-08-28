import { describe, expect, test } from "bun:test";
import { parseTaskNotification } from "./task-notification";

const notification = `<task-notification>
<task-id>a3de4c83975b5520c</task-id>
<output-file>/tmp/tasks/a3de4c83975b5520c.output</output-file>
<status>completed</status>
<summary>Agent "Close the iOS feature gap" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result>Shipped build 202608261337.

It is **valid** in TestFlight.</result>
<usage><subagent_tokens>434045</subagent_tokens><tool_uses>249</tool_uses></usage>
</task-notification>`;

describe("parseTaskNotification", () => {
  test("keeps the summary and the result, and nothing else", () => {
    const parsed = parseTaskNotification(notification);

    expect(parsed).toEqual({
      summary: 'Agent "Close the iOS feature gap" finished',
      result: "Shipped build 202608261337.\n\nIt is **valid** in TestFlight.",
    });
  });

  test("drops the plumbing a phone cannot use", () => {
    const parsed = parseTaskNotification(notification);
    const text = `${parsed?.summary}\n${parsed?.result}`;

    expect(text).not.toContain("a3de4c83975b5520c");
    expect(text).not.toContain("/tmp/tasks");
    expect(text).not.toContain("subagent_tokens");
    expect(text).not.toContain("<note>");
  });

  test("an agent that reported nothing still says which agent finished", () => {
    const parsed = parseTaskNotification(
      "<task-notification><status>failed</status><summary>Agent \"Probe\" finished</summary></task-notification>",
    );

    expect(parsed).toEqual({
      summary: 'Agent "Probe" finished',
      result: 'Agent "Probe" finished',
    });
  });

  test("a result quoting a closing tag survives to its real end", () => {
    const parsed = parseTaskNotification(
      "<task-notification><summary>s</summary><result>I wrote </result> in the doc.</result></task-notification>",
    );

    expect(parsed?.result).toBe("I wrote </result> in the doc.");
  });

  test("ordinary messages are left alone", () => {
    expect(parseTaskNotification("Ship the changelog for 2.4.")).toBeUndefined();
  });

  test("a message that merely quotes a notification is still the person's message", () => {
    expect(
      parseTaskNotification(`Why does this render badly?\n\n${notification}`),
    ).toBeUndefined();
  });

  test("a notification carrying only plumbing is dropped", () => {
    expect(
      parseTaskNotification("<task-notification><task-id>abc</task-id></task-notification>"),
    ).toBeUndefined();
  });
});
