import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeControlInvocation } from "../src/control-decoder.js";

const invocation = (
  toolName: string,
  argumentsJson: string,
): ToolInvocation => ({
  providerTurnId: "ptn_placement" as never,
  outputPosition: 0,
  callRef: `${toolName}-call`,
  toolName,
  argumentsJson,
});

describe("MAC-P2 workspace placement controls", () => {
  it("decodes bounded list and exact read refs", async () => {
    const listed = await Effect.runPromise(
      decodeControlInvocation(
        invocation(
          "list_workspaces",
          JSON.stringify({ cursor: "pc_20", query: "research" }),
        ),
      ),
    );
    expect(listed.action).toEqual({
      _tag: "ListWorkspaces",
      cursor: "pc_20",
      query: "research",
    });
    const read = await Effect.runPromise(
      decodeControlInvocation(
        invocation(
          "read_workspace",
          JSON.stringify({ workspaceRef: "wref_abc" }),
        ),
      ),
    );
    expect(read.action).toEqual({
      _tag: "ReadWorkspace",
      workspaceRef: "wref_abc",
    });
    const accepted = await Effect.runPromise(
      decodeControlInvocation(
        invocation("accept_result", JSON.stringify({ resultRef: "rref_abc" })),
      ),
    );
    expect(accepted.action).toEqual({
      _tag: "AcceptResult",
      resultRef: "rref_abc",
    });
  });

  it("rejects raw ids and malformed list cursors as read refs", async () => {
    const missing = await Effect.runPromise(
      Effect.flip(
        decodeControlInvocation(
          invocation("read_workspace", JSON.stringify({ workspaceId: "ws_x" })),
        ),
      ),
    );
    expect(missing).toMatchObject({ _tag: "InvalidControlArguments" });
    const malformed = await Effect.runPromise(
      Effect.flip(
        decodeControlInvocation(
          invocation("list_workspaces", JSON.stringify({ cursor: 20 })),
        ),
      ),
    );
    expect(malformed).toMatchObject({ _tag: "InvalidControlArguments" });
  });
});
