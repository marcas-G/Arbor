import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeControlInvocation } from "../src/control-decoder.js";
import { fixtureProviderTurnId } from "./fixtures/provider-turn.js";

const invocation = (
  toolName: string,
  argumentsJson: string,
): ToolInvocation => ({
  providerTurnId: fixtureProviderTurnId(),
  outputPosition: 0,
  callRef: `${toolName}-call`,
  toolName,
  argumentsJson,
});

describe("MAC-workspace placement controls", () => {
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

  it("decodes explicit bounded Child allocation and rejects model-authored authority", async () => {
    const selected = {
      targetWorkspaceRef: "wref_child",
      profile: "WorkspaceWrite",
      networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
      expiresAt: null,
    };
    await expect(
      Effect.runPromise(
        decodeControlInvocation(
          invocation("allocate_workspace_sandbox", JSON.stringify(selected)),
        ),
      ),
    ).resolves.toMatchObject({
      action: { _tag: "AllocateWorkspaceSandbox", ...selected },
    });
    for (const change of [
      { targetWorkspaceRef: "current" },
      { workspaceId: "ws_forged" },
      { providerId: "linux-bwrap" },
      { expectedParentAuthorizationRevision: 999 },
      { profile: "FullAccess" },
      { expiresAt: "never" },
      { networkPolicy: { version: 1, mode: "Enabled", destinations: ["*"] } },
    ]) {
      await expect(
        Effect.runPromise(
          decodeControlInvocation(
            invocation(
              "allocate_workspace_sandbox",
              JSON.stringify({ ...selected, ...change }),
            ),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "InvalidControlArguments" });
    }
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
