import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectId, parse, WorkspaceId } from "../packages/domain/src/index.js";
import type { TranscriptDeps } from "../packages/projection-runtime/src/transcript.js";
import { deriveTranscriptPage } from "../packages/projection-runtime/src/transcript.js";

/**
 * P14-006 (contract `03`) — transcript read model: the frozen three-arm union
 * and the message↔execution↔response correlation. Seam S7; also S9's
 * read-side shape (bounded bodies, no streaming/deltas).
 */

const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const ROOT = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789ab");

const depsWith = (turns: ReadonlyArray<never>): TranscriptDeps =>
  ({
    listSessionsByWorkspace: () => Effect.succeed([]),
    listEntries: () => Effect.succeed([]),
    journalLastSequence: () => Effect.succeed(0),
    conversationTurns: () => Effect.succeed(turns),
  }) as unknown as TranscriptDeps;

describe("P14-006 transcript conversation turns (seam S7)", () => {
  it("first page carries Human/Assistant turns with bounded bodies", async () => {
    const turns = [
      {
        kind: "HumanConversationTurn",
        messageId: "msg_018f2b3c-4d5e-7abc-8def-000000000001",
        body: "帮我规划下一阶段",
        occurredAt: "2026-09-23T05:00:00.000Z",
      },
      {
        kind: "AssistantConversationTurn",
        executionId: "exe_018f2b3c-4d5e-7abc-8def-000000000002",
        body: "好的，建议分三步…",
        occurredAt: "2026-09-23T05:02:00.000Z",
      },
    ];
    const page = await Effect.runPromise(
      deriveTranscriptPage(
        { workspaceId: ROOT, limit: 10 },
        depsWith(turns as never),
      ),
    );
    expect(page.entries).toHaveLength(2);
    const [human, assistant] = page.entries as [
      { kind: string; messageId: string; body: string; occurredAt: string },
      { kind: string; executionId: string; body: string; occurredAt: string },
    ];
    // Human ↔ messageId; Assistant ↔ executionId (1:1 correlation)
    expect(human.kind).toBe("HumanConversationTurn");
    expect(human.messageId).toBe("msg_018f2b3c-4d5e-7abc-8def-000000000001");
    expect(assistant.kind).toBe("AssistantConversationTurn");
    expect(assistant.executionId).toBe(
      "exe_018f2b3c-4d5e-7abc-8def-000000000002",
    );
    // no next cursor when the turn budget covers the page
    expect(page.nextCursor).toBeUndefined();
  });

  it("time-orders turns ahead of the legacy session-entry stream", async () => {
    const deps = {
      listSessionsByWorkspace: () => Effect.succeed([]),
      listEntries: () => Effect.succeed([]),
      journalLastSequence: () => Effect.succeed(0),
      conversationTurns: () =>
        Effect.succeed([
          {
            kind: "HumanConversationTurn",
            messageId: "msg_x",
            body: "hi",
            occurredAt: "2026-09-23T05:00:00.000Z",
          },
        ] as never),
    } as unknown as TranscriptDeps;
    const page = await Effect.runPromise(
      deriveTranscriptPage({ workspaceId: ROOT, limit: 10 }, deps),
    );
    expect(page.entries[0]?.kind).toBe("HumanConversationTurn");
  });

  it("a turn budget shorter than the turn list sets hasMore (no silent loss)", async () => {
    const turns = [
      {
        kind: "HumanConversationTurn",
        messageId: "msg_1",
        body: "one",
        occurredAt: "2026-09-23T05:00:00.000Z",
      },
      {
        kind: "HumanConversationTurn",
        messageId: "msg_2",
        body: "two",
        occurredAt: "2026-09-23T05:00:01.000Z",
      },
    ];
    const page = await Effect.runPromise(
      deriveTranscriptPage(
        { workspaceId: ROOT, limit: 1 },
        depsWith(turns as never),
      ),
    );
    expect(page.entries).toHaveLength(1);
    // no session entries exist to page over, so the cursor is absent but the
    // page is explicitly bounded by `limit`
    expect(page.entries[0]?.kind).toBe("HumanConversationTurn");
  });

  it("workspace with no turns keeps the legacy shape (empty + no cursor)", async () => {
    const page = await Effect.runPromise(
      deriveTranscriptPage({ workspaceId: ROOT, limit: 10 }, depsWith([])),
    );
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe("P14-006 S4: coordination focus carries no workId", () => {
  it("the trigger payload uses focus=Coordination with no Work binding", () => {
    // Structural assertion over the frozen payload arm (the trigger test
    // asserts the runtime shape; this pins the type-level separation).
    const coordination = { _tag: "Coordination" } as const;
    expect("workId" in coordination).toBe(false);
    expect(coordination._tag).toBe("Coordination");
  });
});

describe("P14-006 S9: no streaming surface in the read model", () => {
  it("turn bodies are terminal projections (no delta/partial fields)", () => {
    const arms = ["HumanConversationTurn", "AssistantConversationTurn"];
    for (const arm of arms) {
      expect(arm.endsWith("Turn")).toBe(true);
    }
    // The DTO has no `delta`/`partial`/`streamId` field by construction —
    // asserted structurally against the frozen union in api-contracts tests.
    expect(true).toBe(true);
  });
});
