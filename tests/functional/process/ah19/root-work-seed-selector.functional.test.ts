import { afterEach, expect, it } from "vitest";
import {
  ah19AfterEach,
  approvedRootWorkReply,
  makeRootSeedSelectorCase,
} from "./support.js";

afterEach(ah19AfterEach);

it("AH19 Root Work fake ignores a non-tool WorkAssigned text mention", () => {
  const { marker, work, request } = makeRootSeedSelectorCase();
  const reply = approvedRootWorkReply(marker, work);
  const response = reply(
    {
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: "A prior note mentioned WorkAssigned(wrk_example).",
        },
      ],
    },
    0,
  );
  expect(response).toMatchObject({ _tag: "ToolCall", name: "assign_work" });
});

it("AH19 Root Work fake fails closed instead of repeating AssignWork without a ToolResult", () => {
  const { marker, work, request, assignmentToolCall } =
    makeRootSeedSelectorCase();
  const reply = approvedRootWorkReply(marker, work);
  const first = reply(request, 0);
  const second = reply(
    {
      ...request,
      messages: [
        ...request.messages,
        assignmentToolCall("ah19-assign-current"),
      ],
    },
    1,
  );
  expect(first).toMatchObject({ _tag: "ToolCall", name: "assign_work" });
  expect(second).toEqual({ _tag: "HttpError", status: 500 });
  expect(
    [first, second].filter(
      (response) =>
        typeof response !== "string" && response._tag === "ToolCall",
    ),
  ).toHaveLength(1);
});

it("AH19 Root Work fake matches WorkAssigned ToolResult by the emitted call id", () => {
  const { marker, work, request, assignmentToolCall, toolResult } =
    makeRootSeedSelectorCase();
  const reply = approvedRootWorkReply(marker, work);
  const first = reply(request, 0);
  const priorCall = assignmentToolCall("ah19-assign-current");
  const withStaleResult = reply(
    {
      ...request,
      messages: [
        ...request.messages,
        priorCall,
        toolResult("old-unrelated-call", "WorkAssigned(wrk_stale)"),
      ],
    },
    1,
  );
  const withMatchingResult = reply(
    {
      ...request,
      messages: [
        ...request.messages,
        priorCall,
        toolResult("ah19-assign-current", "WorkAssigned(wrk_current)"),
      ],
    },
    2,
  );
  expect(first).toMatchObject({ _tag: "ToolCall", name: "assign_work" });
  expect(withStaleResult).toEqual({ _tag: "HttpError", status: 500 });
  expect(withMatchingResult).toEqual({
    _tag: "Text",
    text: `AH19 Work seed approved: ${marker}`,
  });
});
