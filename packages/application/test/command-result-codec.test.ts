import type { StoredCommandResolution } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  COMMAND_RECEIPT_DECODER_DESCRIPTORS,
  decodeRegisteredCommandReceipt,
} from "../src/command-result-codec.js";

const uuid = "00000000-0000-7000-8000-000000000001";
const id = (prefix: string) => `${prefix}_${uuid}`;

const either = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, {
    onSuccess: (right) => ({ _tag: "Right" as const, right }),
    onFailure: (left) => ({ _tag: "Left" as const, left }),
  });

const stored = (
  overrides: Partial<StoredCommandResolution> = {},
): StoredCommandResolution =>
  ({
    commandId: `cmd_${uuid}` as never,
    projectId: `prj_${uuid}` as never,
    semanticRequestFingerprint: "sha256:receipt-unit" as never,
    schemaVersion: "1",
    fingerprintAlgorithmVersion: 1,
    resolution: "Committed",
    resultJson: JSON.stringify({
      messageId: `msg_${uuid}`,
      state: "Pending",
    }),
    terminalErrorJson: null,
    createdAt: "2026-10-17T00:00:00.000Z",
    settledAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  }) as StoredCommandResolution;

describe("registered command receipt decoders", () => {
  it("declares every required external pair, optional ResolveControlApproval, and internal receipt writer", () => {
    const external = COMMAND_RECEIPT_DECODER_DESCRIPTORS.filter(
      (descriptor) => descriptor.source === "External",
    );
    const internal = COMMAND_RECEIPT_DECODER_DESCRIPTORS.filter(
      (descriptor) => descriptor.source === "Internal",
    );

    expect(external.filter((descriptor) => descriptor.required)).toHaveLength(
      29,
    );
    expect(external.filter((descriptor) => !descriptor.required)).toEqual([
      expect.objectContaining({
        commandType: "ResolveControlApproval",
        schemaVersion: "1",
      }),
    ]);
    expect(internal).toEqual([
      expect.objectContaining({
        commandType: "UpdateResourceBoundary",
        schemaVersion: "1",
      }),
    ]);
  });

  it("accepts a current positive DTO example for every registered descriptor", async () => {
    const projectId = id("prj");
    const workspaceId = id("ws");
    const workId = id("wrk");
    const executionId = id("exe");
    const sessionId = id("ses");
    const verificationId = id("ver");
    const messageId = id("msg");
    const dependencyId = id("dep");
    const deliverableId = id("del");
    const validResults: Readonly<Record<string, unknown>> = {
      CreateProject: {
        projectId,
        rootWorkspaceId: workspaceId,
        primarySessionId: sessionId,
      },
      CreateChildWorkspace: {
        workspaceId,
        projectId,
        parentWorkspaceId: workspaceId,
        primarySessionId: sessionId,
      },
      AssignWork: { workId, workspaceId, lifecycle: "Open", revision: 0 },
      UpdateResourceBoundary: {
        workspaceId,
        revision: 0,
        resourceBoundaryRevision: 0,
        releasedClaimIds: [],
      },
      RenameProject: { revision: 0, name: "Arbor" },
      CloseProject: { revision: 0, lifecycle: "Closed" },
      SelectCurrentWork: { workspaceId, workId, revision: 0 },
      AdmitExecution: {
        executionId,
        workspaceId,
        sessionId,
        bindingKind: "WorkspaceMain",
      },
      StopExecution: { executionId, stopRequestedAt: "2026-10-17T00:00:00Z" },
      SettleExecution: {
        executionId,
        settlement: {
          _tag: "Completed",
          result: {
            _tag: "Yielded",
            reason: "waiting",
            waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
          },
        },
      },
      SendMessage: {
        messageId,
        admitted: true,
        promotion: { closesCorrelation: null, triggersReevaluation: false },
      },
      DeliverMessage: {
        messageId,
        deliverableId,
        senderWorkspaceId: workspaceId,
        recipientWorkspaceId: workspaceId,
        admitted: true,
      },
      DeclareDependency: {
        dependencyId,
        consumerWorkId: workId,
        state: "Unsatisfied",
        revision: 0,
      },
      ProduceDeliverable: {
        deliverableId,
        sourceWorkId: workId,
        sourceWorkRevision: 0,
        kind: "report",
        artifactRoles: [],
      },
      SatisfyDependency: {
        dependencyId,
        state: "Satisfied",
        dependencyRevision: 1,
        deliverableId,
        satisfiedAtDependencyRevision: 1,
        wakeSignals: [],
      },
      RecordDecision: {
        proposalId: id("fpr"),
        proposalRevision: 0,
        decision: "Approve",
        state: "Approved",
      },
      ResolveControlApproval: {
        approvalId: "approval-id",
        executionId,
        state: "Approved",
        revision: 1,
      },
      ResolveExecutableApproval: {
        approvalId: "approval-id",
        executionId,
        state: "Approved",
        revision: 1,
      },
      SteerWork: {
        workId,
        workspaceId,
        lifecycle: "Open",
        fromRevision: 0,
        toRevision: 1,
        severity: "Normal",
      },
      AcceptWorkOutcome: {
        acceptanceId: id("acc"),
        workId,
        targetWorkRevision: 0,
        verificationId,
      },
      CompleteWork: {
        workId,
        workspaceId,
        lifecycle: "Completed",
        revision: 1,
        clearedCurrentWork: true,
      },
      StartVerification: {
        verificationId,
        workId,
        targetWorkRevision: 0,
        ownerWorkspaceId: workspaceId,
        state: "Open",
        verifierExecutionId: executionId,
      },
      RecordVerificationEvidence: {
        verificationId,
        evidenceId: id("evd"),
        state: "Recorded",
      },
      ConcludeVerification: {
        verificationId,
        state: "Concluded",
        verdict: "Unknown",
        summaryRef: "sha256:summary",
        wakeSignals: [],
        channel1Release: { workId, targetWorkRevision: 0 },
      },
      RetryVerification: {
        workId,
        orphanedVerificationId: verificationId,
        successorVerificationId: id("ver"),
        verifierExecutionId: executionId,
        state: "OrphanedAndRetried",
      },
      GrantPermission: { permissionGrantId: id("pgr"), state: "Active" },
      RevokePermission: { permissionGrantId: id("pgr"), state: "Revoked" },
      SubmitHumanMessage: { messageId, state: "Pending" },
      ResumeConversationResponse: {
        messageId,
        state: "Queued",
        revision: 1,
      },
      CancelConversationResponse: {
        messageId,
        state: "Cancelled",
        revision: 1,
      },
    };

    for (const descriptor of COMMAND_RECEIPT_DECODER_DESCRIPTORS) {
      const result =
        descriptor.commandType === "ConcludeVerification" &&
        descriptor.schemaVersion === "2"
          ? {
              ...(validResults.ConcludeVerification as Record<string, unknown>),
              verdict: "Pass",
              missionSnapshot: {
                goal: "goal",
                criteria: [
                  {
                    criterionId: "criterion-1",
                    requirement: "requirement-1",
                    required: true,
                  },
                ],
                riskRequirements: [],
              },
              criteriaResults: [
                {
                  criterionId: "criterion-1",
                  requirement: "requirement-1",
                  required: true,
                  verdict: "Pass",
                  evidenceRefs: [`evd_${uuid}`],
                },
              ],
              snapshotStatus: "Available",
            }
          : validResults[descriptor.commandType];
      expect(
        result,
        `${descriptor.commandType}@${descriptor.schemaVersion}`,
      ).toBeDefined();
      const decoded = await Effect.runPromise(
        either(
          decodeRegisteredCommandReceipt(
            stored({
              schemaVersion: descriptor.schemaVersion,
              resultJson: JSON.stringify(result),
            }),
            descriptor.commandType,
            descriptor.schemaVersion,
          ),
        ),
      );
      expect(
        decoded._tag,
        `${descriptor.commandType}@${descriptor.schemaVersion}`,
      ).toBe("Right");
    }
  });

  it("decodes exact registered committed DTOs and restores the omitted optional ConcludeVerification field", async () => {
    const conclusion = stored({
      resolution: "Committed",
      resultJson: JSON.stringify({
        verificationId: `ver_${uuid}`,
        state: "Concluded",
        verdict: "Unknown",
        summaryRef: "sha256:summary",
        wakeSignals: [],
        channel1Release: {
          workId: `wrk_${uuid}`,
          targetWorkRevision: 1,
        },
      }),
      terminalErrorJson: null,
    });

    const decoded = await Effect.runPromise(
      decodeRegisteredCommandReceipt(conclusion, "ConcludeVerification", "1"),
    );

    expect(decoded.resolution._tag).toBe("Committed");
    if (decoded.resolution._tag === "Committed") {
      expect(decoded.resolution.result).toHaveProperty(
        "conclusionReason",
        undefined,
      );
    }
  });

  it("keeps ConcludeVerification v1 strict while decoding its exact v2 snapshot DTO", async () => {
    const base = {
      verificationId: `ver_${uuid}`,
      state: "Concluded",
      verdict: "Pass",
      summaryRef: "sha256:summary",
      wakeSignals: [],
      channel1Release: {
        workId: `wrk_${uuid}`,
        targetWorkRevision: 1,
      },
    };
    const v1WithV2Fields = await Effect.runPromise(
      either(
        decodeRegisteredCommandReceipt(
          stored({
            resultJson: JSON.stringify({
              ...base,
              missionSnapshot: {
                goal: "goal",
                criteria: [],
                riskRequirements: [],
              },
              criteriaResults: [],
              snapshotStatus: "Available",
            }),
          }),
          "ConcludeVerification",
          "1",
        ),
      ),
    );
    expect(v1WithV2Fields._tag).toBe("Left");

    const v2Result = {
      ...base,
      missionSnapshot: {
        goal: "goal",
        criteria: [
          {
            criterionId: "criterion-1",
            requirement: "requirement-1",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      criteriaResults: [
        {
          criterionId: "criterion-1",
          requirement: "requirement-1",
          required: true,
          verdict: "Pass",
          evidenceRefs: [`evd_${uuid}`],
        },
      ],
      snapshotStatus: "Available",
    };
    const v2 = await Effect.runPromise(
      decodeRegisteredCommandReceipt(
        stored({ schemaVersion: "2", resultJson: JSON.stringify(v2Result) }),
        "ConcludeVerification",
        "2",
      ),
    );
    expect(v2.resolution._tag).toBe("Committed");

    for (const invalid of [
      { ...v2Result, unexpected: true },
      { ...v2Result, criteriaResults: [] },
      {
        ...v2Result,
        criteriaResults: [{ ...v2Result.criteriaResults[0], verdict: "Fail" }],
      },
    ]) {
      const rejected = await Effect.runPromise(
        either(
          decodeRegisteredCommandReceipt(
            stored({ schemaVersion: "2", resultJson: JSON.stringify(invalid) }),
            "ConcludeVerification",
            "2",
          ),
        ),
      );
      expect(rejected._tag).toBe("Left");
    }
  });

  it("decodes the internal P1 resource-boundary receipt and rejects unregistered command types", async () => {
    const internal = stored({
      resultJson: JSON.stringify({
        workspaceId: `ws_${uuid}`,
        revision: 1,
        resourceBoundaryRevision: 1,
        releasedClaimIds: [],
      }),
    });
    const decoded = await Effect.runPromise(
      decodeRegisteredCommandReceipt(internal, "UpdateResourceBoundary", "1"),
    );
    expect(decoded.resolution._tag).toBe("Committed");

    const unknown = await Effect.runPromise(
      either(decodeRegisteredCommandReceipt(stored(), "UnknownCommand", "1")),
    );
    expect(unknown._tag).toBe("Left");
  });

  it("fails closed for malformed JSON, wrong result shape, unknown versions, and corrupt resolution columns", async () => {
    const cases = [
      stored({ resultJson: '{"sentinel":', terminalErrorJson: null }),
      stored({ resultJson: JSON.stringify({ sentinel: "private" }) }),
      stored({ schemaVersion: "99" }),
      stored({ resolution: "Unknown" as never }),
      stored({ resultJson: null }),
    ];

    for (const row of cases) {
      const result = await Effect.runPromise(
        either(decodeRegisteredCommandReceipt(row, "SubmitHumanMessage", "1")),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toMatchObject({
          _tag: "PersistenceCorruption",
          repository: "CommandStore",
          operation: "decodeReceipt",
          reason: "stored command receipt does not match its registered schema",
        });
        expect(JSON.stringify(result.left)).not.toContain("sentinel");
        expect(JSON.stringify(result.left)).not.toContain("private");
      }
    }
  });

  it("validates the complete rejection union and rejects extra or missing members", async () => {
    const valid = stored({
      resolution: "TerminalRejected",
      resultJson: null,
      terminalErrorJson: JSON.stringify({
        _tag: "IdempotencyConflict",
        commandId: `cmd_${uuid}`,
      }),
    });
    const decoded = await Effect.runPromise(
      decodeRegisteredCommandReceipt(valid, "SubmitHumanMessage", "1"),
    );
    expect(decoded.resolution._tag).toBe("TerminalRejected");

    for (const error of [
      { _tag: "IdempotencyConflict" },
      {
        _tag: "IdempotencyConflict",
        commandId: "cmd_f23receiptunit0000000000000000000000",
        detail: "private",
      },
      { _tag: "NotInUnion" },
    ]) {
      const result = await Effect.runPromise(
        either(
          decodeRegisteredCommandReceipt(
            stored({
              resolution: "TerminalRejected",
              resultJson: null,
              terminalErrorJson: JSON.stringify(error),
            }),
            "SubmitHumanMessage",
            "1",
          ),
        ),
      );
      expect(result._tag).toBe("Left");
    }
  });
});
