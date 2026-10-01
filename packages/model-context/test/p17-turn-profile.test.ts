import type { Execution } from "@arbor/domain";
import {
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeTurnProfileResolver } from "../src/turn-profile.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const base: Omit<Execution, "binding"> = {
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  workspaceId,
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};

const resolver = makeTurnProfileResolver({
  toolCatalog: {
    visibleRefs: () =>
      Effect.succeed([{ name: "read", version: "1", hash: "read-hash" }]),
    resolveForModel: () =>
      Effect.succeed({
        name: "read",
        description: "read",
        schemaJson: "{}",
        version: "1",
        hash: "read-hash",
        capabilityMetadata: [],
        sideEffectSemantics: "ReadOnly",
      }),
  },
  controlCatalog: {
    visibleDefinitions: () =>
      Effect.succeed([
        {
          name: "arbor_claim_completion",
          description: "claim",
          schemaJson: "{}",
          version: "1",
          hash: "claim-hash",
          requiredCapability: "agent:claim-completion",
        },
        {
          name: "arbor_send_message",
          description: "send",
          schemaJson: "{}",
          version: "1",
          hash: "send-hash",
          requiredCapability: "agent:communicate",
        },
      ]),
  },
});

describe("P17 TurnProfileResolver", () => {
  it("gives Root Conversation an exact zero-tool text profile", async () => {
    const profile = await Effect.runPromise(
      resolver.resolve({
        conversation: true,
        execution: {
          ...base,
          binding: {
            _tag: "WorkspaceExecution",
            workspaceId,
            focus: { _tag: "Coordination" },
          },
        },
      }),
    );
    expect(profile).toMatchObject({
      purpose: "RootConversationRespond",
      outputContractRef: "text-response-v1",
      executableTools: [],
      controlTools: [],
      fingerprint: expect.stringMatching(/^tpf_/),
    });
  });

  it("materializes Work tools and applicable controls deterministically", async () => {
    const execution: Execution = {
      ...base,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId,
        focus: {
          _tag: "Work",
          workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1"),
        },
      },
    };
    const first = await Effect.runPromise(
      resolver.resolve({ execution, conversation: false }),
    );
    const second = await Effect.runPromise(
      resolver.resolve({ execution, conversation: false }),
    );
    expect(first).toEqual(second);
    expect(first.executableTools.map((tool) => tool.name)).toEqual(["read"]);
    expect(first.controlTools.map((tool) => tool.name)).toEqual([
      "arbor_claim_completion",
      "arbor_send_message",
    ]);
  });

  it("does not expose Work-only completion to an ExecutionBound specialist", async () => {
    const profile = await Effect.runPromise(
      resolver.resolve({
        conversation: false,
        execution: {
          ...base,
          binding: {
            _tag: "ExecutionBoundAgentBinding",
            parentExecutionId: base.executionId,
            mission: "bounded review",
          },
        },
      }),
    );
    expect(profile.executableTools).toEqual([]);
    expect(profile.controlTools.map((tool) => tool.name)).toEqual([
      "arbor_send_message",
    ]);
  });
});
