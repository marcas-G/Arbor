import type { Execution } from "@arbor/domain";
import {
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { Effect, Option } from "effect";
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
          stableId: "core.control.claim-completion",
          name: "claim_completion",
          description: "claim",
          schemaJson: "{}",
          version: "1",
          hash: "claim-hash",
          requiredCapability: "agent:claim-completion",
        },
        {
          stableId: "core.control.send-message",
          name: "send_message",
          description: "send",
          schemaJson: "{}",
          version: "1",
          hash: "send-hash",
          requiredCapability: "agent:communicate",
        },
        {
          stableId: "core.control.assign-work",
          name: "assign_work",
          description: "assign work",
          schemaJson: "{}",
          version: "1",
          hash: "assign-hash",
          requiredCapability: "agent:assign-work",
        },
        {
          stableId: "core.control.list-workspaces",
          name: "list_workspaces",
          description: "list workspaces",
          schemaJson: "{}",
          version: "1",
          hash: "list-workspaces-hash",
          requiredCapability: "agent:inspect-workspaces",
        },
        {
          stableId: "core.control.read-workspace",
          name: "read_workspace",
          description: "read workspace",
          schemaJson: "{}",
          version: "1",
          hash: "read-workspace-hash",
          requiredCapability: "agent:inspect-workspaces",
        },
        {
          stableId: "core.control.accept-result",
          name: "accept_result",
          description: "accept child result",
          schemaJson: "{}",
          version: "1",
          hash: "accept-result-hash",
          requiredCapability: "agent:accept-result",
        },
        {
          stableId: "core.control.select-current-work",
          name: "select_current_work",
          description: "select work",
          schemaJson: "{}",
          version: "1",
          hash: "select-hash",
          requiredCapability: "agent:select-work",
        },
        {
          stableId: "core.control.update-plan",
          name: "update_plan",
          description: "update plan",
          schemaJson: "{}",
          version: "1",
          hash: "plan-hash",
          requiredCapability: "agent:plan",
        },
        {
          stableId: "core.control.record-verification-evidence",
          name: "record_verification_evidence",
          description: "record evidence",
          schemaJson: "{}",
          version: "1",
          hash: "record-hash",
          requiredCapability: "agent:verify",
        },
        {
          stableId: "core.control.conclude-verification",
          name: "conclude_verification",
          description: "conclude",
          schemaJson: "{}",
          version: "1",
          hash: "conclude-hash",
          requiredCapability: "agent:verify",
        },
        {
          stableId: "core.control.propose-workspace",
          name: "propose_workspace",
          description: "propose a governed child workspace",
          schemaJson: "{}",
          version: "2",
          hash: "propose-hash",
          requiredCapability: "agent:formation",
        },
      ]),
  },
  verificationForExecution: (executionId) =>
    Effect.succeed(
      String(executionId).endsWith("a2")
        ? Option.some({} as import("@arbor/domain").Verification)
        : Option.none(),
    ),
});

describe("P17 TurnProfileResolver", () => {
  it("gives Root Conversation zero executable tools and only placement/work-initiation controls", async () => {
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
      purpose: "RootConversation",
      outputContractRef: "tool-invocation-v1",
      executableTools: [],
      fingerprint: expect.stringMatching(/^tpf_/),
    });
    expect(profile.controlTools.map((tool) => tool.name)).toEqual([
      "assign_work",
      "list_workspaces",
      "read_workspace",
      "accept_result",
      "propose_workspace",
    ]);
  });

  it("materializes Work tools and applicable controls deterministically", async () => {
    const execution: Execution = {
      ...base,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId,
        episode: {
          _tag: "WorkEpisode",
          workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1"),
          targetWorkRevision: 0 as never,
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
      "claim_completion",
      "send_message",
      "assign_work",
      "list_workspaces",
      "read_workspace",
      "accept_result",
      "update_plan",
      "propose_workspace",
    ]);
  });

  it("gives Decision and Inbox episodes disjoint minimal control surfaces", async () => {
    const decision = await Effect.runPromise(
      resolver.resolve({
        conversation: false,
        execution: {
          ...base,
          binding: {
            _tag: "WorkspaceExecution",
            workspaceId,
            episode: {
              _tag: "DecisionEpisode",
              decisionId: "dec_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
              decisionKind: "SelectCurrentWork",
              requestRevision: 0,
            },
          },
        },
      }),
    );
    expect(decision.executableTools).toEqual([]);
    expect(decision.controlTools.map((tool) => tool.name)).toEqual([
      "select_current_work",
    ]);

    const inbox = await Effect.runPromise(
      resolver.resolve({
        conversation: false,
        execution: {
          ...base,
          binding: {
            _tag: "WorkspaceExecution",
            workspaceId,
            episode: {
              _tag: "InboxEpisode",
              entryKey: "msg:test",
              inputKind: "Message",
            },
          },
        },
      }),
    );
    expect(inbox.controlTools.map((tool) => tool.name)).toEqual([
      "send_message",
      "list_workspaces",
      "read_workspace",
      "accept_result",
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
    expect(profile.controlTools).toEqual([]);
  });

  it("recognizes a durably bound verifier and exposes only verification tools", async () => {
    const profile = await Effect.runPromise(
      resolver.resolve({
        conversation: false,
        execution: {
          ...base,
          executionId: parse(ExecutionId)(
            "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
          ),
          binding: {
            _tag: "ExecutionBoundAgentBinding",
            parentExecutionId: base.executionId,
            mission: "verify the bound work",
          },
        },
      }),
    );
    expect(profile.purpose).toBe("Verifier");
    expect(profile.executableTools.map((tool) => tool.name)).toEqual(["read"]);
    expect(profile.controlTools.map((tool) => tool.name)).toEqual([
      "record_verification_evidence",
      "conclude_verification",
    ]);
  });
});
