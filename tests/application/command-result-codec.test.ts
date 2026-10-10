import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  CommandInputContractRegistry,
  decodeRegisteredCommandReceipt,
  isCommandRejection,
} from "../../packages/application/src/index.js";
import type { StoredCommandResolution } from "../../packages/ports/src/index.js";

const uuid = "018f2b3c-4d5e-7abc-8def-0123456789af";
const id = (prefix: string) => `${prefix}${uuid}`;

const resultByCommand = {
  CreateProject: {
    projectId: id("prj_"),
    rootWorkspaceId: id("ws_"),
    primarySessionId: id("ses_"),
  },
  CreateChildWorkspace: {
    workspaceId: id("ws_"),
    projectId: id("prj_"),
    parentWorkspaceId: id("ws_"),
    primarySessionId: id("ses_"),
  },
  AssignWork: {
    workId: id("wrk_"),
    workspaceId: id("ws_"),
    lifecycle: "Open",
    revision: 0,
  },
  RenameProject: { revision: 0, name: "project" },
  CloseProject: { revision: 1, lifecycle: "Closed" },
  SelectCurrentWork: {
    workspaceId: id("ws_"),
    workId: id("wrk_"),
    revision: 0,
  },
  AdmitExecution: {
    executionId: id("exe_"),
    workspaceId: id("ws_"),
    sessionId: id("ses_"),
    bindingKind: "WorkspaceMain",
  },
  StopExecution: {
    executionId: id("exe_"),
    stopRequestedAt: "2026-10-10T00:00:00.000Z",
  },
  SettleExecution: {
    executionId: id("exe_"),
    settlement: {
      _tag: "Completed",
      result: {
        _tag: "Yielded",
        reason: "wait",
        waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
      },
    },
  },
  SendMessage: {
    messageId: id("msg_"),
    admitted: true,
    promotion: { closesCorrelation: null, triggersReevaluation: false },
  },
  DeclareDependency: {
    dependencyId: id("dep_"),
    consumerWorkId: id("wrk_"),
    state: "Unsatisfied",
    revision: 0,
  },
  ProduceDeliverable: {
    deliverableId: id("del_"),
    sourceWorkId: id("wrk_"),
    sourceWorkRevision: 0,
    kind: "Artifact",
    artifactRoles: [],
  },
  SatisfyDependency: {
    dependencyId: id("dep_"),
    state: "Satisfied",
    dependencyRevision: 1,
    deliverableId: id("del_"),
    satisfiedAtDependencyRevision: 1,
    wakeSignals: [
      {
        workspaceId: id("ws_"),
        reason: { _tag: "DependencySatisfied" },
        detail: { dependencyId: id("dep_"), fromRevision: 0, toRevision: 1 },
      },
    ],
  },
  RecordDecision: {
    proposalId: id("fpr_"),
    proposalRevision: 1,
    decision: "Approve",
    state: "Approved",
  },
  ResolveControlApproval: {
    approvalId: "approval-1",
    executionId: "execution-1",
    state: "Approved",
    revision: 1,
  },
  SteerWork: {
    workId: id("wrk_"),
    workspaceId: id("ws_"),
    lifecycle: "Open",
    fromRevision: 0,
    toRevision: 1,
    severity: "Normal",
  },
  AcceptWorkOutcome: {
    acceptanceId: id("acc_"),
    workId: id("wrk_"),
    targetWorkRevision: 1,
    verificationId: id("ver_"),
  },
  CompleteWork: {
    workId: id("wrk_"),
    workspaceId: id("ws_"),
    lifecycle: "Completed",
    revision: 1,
    clearedCurrentWork: true,
  },
  StartVerification: {
    verificationId: id("ver_"),
    workId: id("wrk_"),
    targetWorkRevision: 0,
    ownerWorkspaceId: id("ws_"),
    state: "Open",
    verifierExecutionId: id("exe_"),
  },
  RecordVerificationEvidence: {
    verificationId: id("ver_"),
    evidenceId: id("evd_"),
    state: "Recorded",
  },
  ConcludeVerification: {
    verificationId: id("ver_"),
    state: "Concluded",
    verdict: "Pass",
    summaryRef: "blob:summary",
    wakeSignals: [
      {
        workspaceId: id("ws_"),
        reason: { _tag: "VerificationReturned" },
        detail: {
          verificationId: id("ver_"),
          workId: id("wrk_"),
          workRevision: 0,
          verdict: "Pass",
        },
      },
    ],
    channel1Release: { workId: id("wrk_"), targetWorkRevision: 0 },
  },
  GrantPermission: { permissionGrantId: id("pgr_"), state: "Active" },
  RevokePermission: { permissionGrantId: id("pgr_"), state: "Revoked" },
  SubmitHumanMessage: { messageId: "human-message-1", state: "Pending" },
  ResumeConversationResponse: {
    messageId: id("msg_"),
    state: "Queued",
    revision: 1,
  },
  CancelConversationResponse: {
    messageId: id("msg_"),
    state: "Cancelled",
    revision: 2,
  },
} as const;

const storedReceipt = (
  resolution: "Committed" | "TerminalRejected",
  resultJson: string | null,
  terminalErrorJson: string | null,
): StoredCommandResolution => ({
  commandId: id("cmd_") as StoredCommandResolution["commandId"],
  projectId: id("prj_") as StoredCommandResolution["projectId"],
  semanticRequestFingerprint: "f".repeat(
    64,
  ) as StoredCommandResolution["semanticRequestFingerprint"],
  schemaVersion: "1",
  fingerprintAlgorithmVersion: 1,
  resolution,
  resultJson,
  terminalErrorJson,
  createdAt: "2026-10-10T00:00:00.000Z",
  settledAt: "2026-10-10T00:00:00.000Z",
});

describe("registered command receipt runtime decoders", () => {
  it("has a positive schema-v1 result example for every registered command", async () => {
    const registered = [...CommandInputContractRegistry.commandTypes].sort();
    expect(registered).toEqual(Object.keys(resultByCommand).sort());

    for (const commandType of CommandInputContractRegistry.commandTypes) {
      const stored = storedReceipt(
        "Committed",
        JSON.stringify(resultByCommand[commandType]),
        null,
      );
      const exit = await Effect.runPromiseExit(
        decodeRegisteredCommandReceipt(stored, commandType, "1"),
      );
      expect(Exit.isSuccess(exit), commandType).toBe(true);
      if (Exit.isSuccess(exit)) {
        const resolution = exit.value.resolution;
        expect(resolution._tag, commandType).toBe("Committed");
        if (
          resolution._tag === "Committed" &&
          commandType === "ConcludeVerification"
        ) {
          expect(resolution.result).toHaveProperty(
            "conclusionReason",
            undefined,
          );
        }
      }
    }
  });

  it("decodes complete rejection fields and rejects missing, extra, or inherited tags", async () => {
    const rejectionExamples = [
      { _tag: "IdempotencyConflict", commandId: id("cmd_") },
      { _tag: "AuthorityDenied", reason: "no" },
      { _tag: "RevisionConflict", expected: 1, actual: 2 },
      { _tag: "InvalidProjectName", reason: "invalid" },
      { _tag: "WorkNotOpen", workId: id("wrk_") },
      {
        _tag: "TerminalLifecycleMutation",
        entity: "Work",
        lifecycle: "Completed",
      },
      {
        _tag: "RetirePreconditionFailed",
        workspaceId: id("ws_"),
        reason: "active",
      },
      { _tag: "ActiveExecutionConflict", workspaceId: id("ws_") },
      { _tag: "VerificationAcceptanceMismatch", workId: id("wrk_") },
      { _tag: "DependencyNotSatisfiable", dependencyId: id("dep_") },
      { _tag: "PermissionRevoked", permissionGrantId: id("pgr_") },
      { _tag: "WorkPlanInvalid", reason: "invalid" },
      { _tag: "FencingRejected" },
      { _tag: "ExecutionStopping" },
      { _tag: "WorkspaceNotFound", workspaceId: id("ws_") },
      { _tag: "ExecutionNotFound", executionId: id("exe_") },
      { _tag: "WorkNotFound", workId: id("wrk_") },
      { _tag: "FormationProposalNotFound", proposalId: id("fpr_") },
      { _tag: "ResourceExhausted", reason: "full" },
      { _tag: "DependencyNotFound", dependencyId: id("dep_") },
      { _tag: "DeliverableNotFound", deliverableId: id("del_") },
      { _tag: "VerificationAlreadyOpen", workId: id("wrk_") },
      { _tag: "InvalidVerificationMission", reason: "invalid" },
      { _tag: "VerificationNotFound", verificationId: id("ver_") },
      { _tag: "AcceptanceAlreadyExists", workId: id("wrk_") },
      { _tag: "WorktreeNotFound", worktreeId: "worktree-1" },
      { _tag: "WorktreeAlreadyExists", worktreeId: "worktree-1" },
      {
        _tag: "WorkspaceNotActive",
        workspaceId: id("ws_"),
        lifecycle: "Retired",
      },
      { _tag: "WorktreeAlreadyRetired", worktreeId: "worktree-1" },
      {
        _tag: "ActiveClaimsExist",
        worktreeId: "worktree-1",
        claimIds: ["claim-1"],
      },
    ] as const;

    for (const example of rejectionExamples) {
      expect(isCommandRejection(example), example._tag).toBe(true);
      const exit = await Effect.runPromiseExit(
        decodeRegisteredCommandReceipt(
          storedReceipt("TerminalRejected", null, JSON.stringify(example)),
          "CreateProject",
          "1",
        ),
      );
      expect(Exit.isSuccess(exit), example._tag).toBe(true);
    }
    expect(
      isCommandRejection({
        _tag: "AuthorityDenied",
        reason: "no",
        extra: true,
      }),
    ).toBe(false);
    expect(isCommandRejection({ _tag: "AuthorityDenied" })).toBe(false);
    expect(isCommandRejection({ _tag: "constructor" })).toBe(false);
  });

  it("fails closed for malformed JSON and unsupported exact schema versions", async () => {
    const malformed = storedReceipt("Committed", "{", null);
    const malformedExit = await Effect.runPromiseExit(
      decodeRegisteredCommandReceipt(malformed, "CreateProject", "1"),
    );
    expect(Exit.isFailure(malformedExit)).toBe(true);

    const unsupported = {
      ...storedReceipt(
        "Committed",
        JSON.stringify(resultByCommand.CreateProject),
        null,
      ),
      schemaVersion: "2",
    };
    const unsupportedExit = await Effect.runPromiseExit(
      decodeRegisteredCommandReceipt(unsupported, "CreateProject", "2"),
    );
    expect(Exit.isFailure(unsupportedExit)).toBe(true);

    const inheritedNestedTag = storedReceipt(
      "Committed",
      JSON.stringify({
        executionId: id("exe_"),
        settlement: {
          _tag: "Completed",
          result: { _tag: "constructor" },
        },
      }),
      null,
    );
    const inheritedTagExit = await Effect.runPromiseExit(
      decodeRegisteredCommandReceipt(
        inheritedNestedTag,
        "SettleExecution",
        "1",
      ),
    );
    expect(Exit.isFailure(inheritedTagExit)).toBe(true);
  });
});
