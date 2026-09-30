import type { InboxEntry } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { assembleInboxContext } from "../src/inbox-context.js";

describe("InboxContextAssembler", () => {
  it("returns bounded source-linked steer and message context", () => {
    const entries = [
      {
        entryKey: "steer:w:2",
        kind: "HumanInput",
        summary: "Normal steer: focus on risk",
      },
      {
        entryKey: "msg:m1",
        kind: "Message",
        summary: "parent asks for evidence",
      },
    ] as unknown as ReadonlyArray<InboxEntry>;
    const result = assembleInboxContext(entries);
    expect(result.messages.map((message) => message.text)).toEqual([
      "[Inbox:HumanInput] Normal steer: focus on risk",
      "[Inbox:Message] parent asks for evidence",
    ]);
    expect(result.contextRefs).toEqual(["inbox:steer:w:2", "inbox:msg:m1"]);
  });
});
