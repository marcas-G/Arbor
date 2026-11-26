// REAL S4 bounded shell gate unit oracle (B5 split): the held-response
// decoder must accept exactly one bounded shell Get-Date call and reject
// everything else. Bodies are moved verbatim from the former monolithic
// public-s4-recovery.test.ts.
import { expect, it } from "vitest";
import { requireSingleShellGetDateToolCall } from "./support/shell-get-date.js";

it("S4-B gate requires exactly one bounded shell Get-Date call", () => {
  const stream = [
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  name: "shell",
                  arguments:
                    '{"command":"Get-Date","cwd":{"mount":"workspace","path":"."},"timeoutMs":5000}',
                },
              },
            ],
          },
        },
      ],
    })}\n`,
    "data: [DONE]\n",
  ].join("");
  const response = Buffer.from(stream).toString("base64");
  expect(requireSingleShellGetDateToolCall(response)).toMatchObject({
    name: "shell",
    arguments: {
      command: "Get-Date",
      cwd: { mount: "workspace", path: "." },
      timeoutMs: 5_000,
    },
  });
  const extraTool = Buffer.from(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { name: "shell", arguments: "{}" },
              },
              {
                index: 1,
                function: { name: "patch", arguments: "{}" },
              },
            ],
          },
        },
      ],
    })}\n`,
  ).toString("base64");
  expect(() => requireSingleShellGetDateToolCall(extraTool)).toThrow(
    "exactly one tool call",
  );
});
