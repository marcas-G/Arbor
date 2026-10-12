import { describe, expect, it } from "vitest";
import type { InboxEntry } from "../packages/domain/dist/index.js";
import { selectWorkspaceInboxEpisode } from "../packages/execution-runtime/src/wake-consumer.js";

const entry = (kind: InboxEntry["kind"], entryKey: string): InboxEntry => ({
  recipientWorkspaceId:
    "ws_00000000-0000-7000-8000-0000000000b1" as InboxEntry["recipientWorkspaceId"],
  entryKey,
  kind,
  summary: "bounded input",
  admittedAt: "2026-10-12T00:00:00.000Z",
});

describe("P6 WorkBlocked Parent Inbox input", () => {
  it("uses the exact InboxEpisode path without treating WorkBlocked as Session text", () => {
    const blocked = entry(
      "WorkBlocked",
      "exe_00000000-0000-7000-8000-0000000000b1",
    );
    const governance = entry("Governance", "gov:pending");
    expect(selectWorkspaceInboxEpisode([governance, blocked])).toBe(blocked);
  });

  it("preserves the existing first eligible important-input ordering", () => {
    const message = entry("Message", "msg:first");
    const blocked = entry("WorkBlocked", "exe:second");
    expect(selectWorkspaceInboxEpisode([message, blocked])).toBe(message);
  });
});
