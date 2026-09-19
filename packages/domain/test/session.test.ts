import { describe, expect, it } from "vitest";
import type { Session, SessionBinding } from "../src/index.js";
import {
  appendSessionEntry,
  ContextEpochNumber,
  compactSession,
  createSession,
  ExecutionId,
  parse,
  SessionId,
  WorkspaceId,
} from "../src/index.js";

const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789ab",
);

const workspacePrimary: SessionBinding = {
  _tag: "WorkspacePrimary",
  workspaceId,
};
const executionScoped: SessionBinding = {
  _tag: "ExecutionScoped",
  executionId,
};

const describeBinding = (binding: SessionBinding): string => {
  switch (binding._tag) {
    case "WorkspacePrimary":
      return `workspace:${binding.workspaceId}`;
    case "ExecutionScoped":
      return `execution:${binding.executionId}`;
    default: {
      const unreachable: never = binding;
      return unreachable;
    }
  }
};

describe("session aggregate", () => {
  it("supports both frozen SessionBinding variants", () => {
    expect(describeBinding(workspacePrimary)).toBe(`workspace:${workspaceId}`);
    expect(describeBinding(executionScoped)).toBe(`execution:${executionId}`);
  });

  it("creates an empty session with no business lifecycle", () => {
    const session = createSession({
      sessionId,
      binding: workspacePrimary,
      contextEpoch: parse(ContextEpochNumber)(0),
    });
    expect(session.entries).toEqual([]);
    expect(session.checkpoints).toEqual([]);
    expect(session.sessionId).toBe(sessionId);
    expect("lifecycle" in session).toBe(false);
    expect("status" in session).toBe(false);
  });

  it("appends entries with a monotonic local sequence and stays append-only", () => {
    const session = createSession({
      sessionId,
      binding: executionScoped,
      contextEpoch: parse(ContextEpochNumber)(0),
    });
    const first = appendSessionEntry(session, { ref: "turn-1" });
    const second = appendSessionEntry(first, { ref: "turn-2" });
    expect(session.entries).toHaveLength(0);
    expect(first.entries).toHaveLength(1);
    expect(second.entries.map((entry) => entry.sequence)).toEqual([0, 1]);
    expect(second.entries.map((entry) => entry.ref)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("compaction creates a new checkpoint and increments the epoch", () => {
    const session = createSession({
      sessionId,
      binding: workspacePrimary,
      contextEpoch: parse(ContextEpochNumber)(3),
    });
    const compacted = compactSession(session, { ref: "checkpoint-1" });
    expect(compacted.contextEpoch).toBe(4);
    expect(compacted.checkpoints).toEqual([{ ref: "checkpoint-1" }]);
    expect(session.contextEpoch).toBe(3);
    expect(session.checkpoints).toEqual([]);
  });

  it("schema field-presence: no canonical business truth on Session", () => {
    const session: Session = createSession({
      sessionId,
      binding: workspacePrimary,
      contextEpoch: parse(ContextEpochNumber)(0),
    });
    const forbidden = [
      "responsibility",
      "currentWork",
      "currentWorkId",
      "permission",
      "dependency",
      "verdict",
      "ownership",
    ];
    for (const field of forbidden) {
      expect(field in session).toBe(false);
    }
  });
});
