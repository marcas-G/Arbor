import type { Verification } from "@arbor/domain";
import { decodeSupportedEventPayload } from "@arbor/domain";
import type { VerificationSignalReconciliationRow } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { runVerificationSignalReconciliationSweep } from "../src/verification-signal-reconciliation.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const rootWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a2" as never;
const childWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a3" as never;
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789a4" as never;
const verificationId = "ver_018f2b3c-4d5e-7abc-8def-0123456789a5" as never;
const commandId = "cmd_018f2b3c-4d5e-7abc-8def-0123456789a6" as never;
const eventId = "evt_018f2b3c-4d5e-7abc-8def-0123456789a7" as never;
const evidenceId = "evd_018f2b3c-4d5e-7abc-8def-0123456789a8" as never;
const occurredAt = "2026-10-21T00:00:00.000Z";

const missionSnapshot = {
  goal: "verify child output",
  criteria: [
    { criterionId: "criterion-1", requirement: "proof exists", required: true },
  ],
  riskRequirements: [],
};
const criteriaResults = [
  {
    criterionId: "criterion-1",
    requirement: "proof exists",
    required: true,
    verdict: "Pass",
    evidenceRefs: [evidenceId],
  },
] as const;
const verification: Verification = {
  verificationId,
  workId,
  ownerWorkspaceId: childWorkspaceId,
  targetWorkRevision: 0 as never,
  missionSnapshot,
  criteriaResults,
  snapshotStatus: "Available",
  targetDeliverables: [],
  targetArtifactVersions: [],
  targetEnvironmentRevision: null,
  environmentSnapshotRef: null,
  evidenceRefs: [evidenceId],
  verificationExecutionIds: [],
  summaryRef: "sha256:verification-summary",
  state: { status: "Concluded", verdict: "Pass" },
};
const payload = {
  verificationId,
  workId,
  targetWorkRevision: 0,
  verdict: "Pass",
  conclusionReason: null,
  evidenceRefs: [evidenceId],
  summaryRef: verification.summaryRef,
  missionSnapshot,
  criteriaResults,
  snapshotStatus: "Available",
};
const result = {
  verificationId,
  state: "Concluded",
  verdict: "Pass",
  summaryRef: verification.summaryRef,
  conclusionReason: null,
  wakeSignals: [],
  channel1Release: { workId, targetWorkRevision: 0 },
  missionSnapshot,
  criteriaResults,
  snapshotStatus: "Available",
};
const candidate = {
  eventIdRaw: eventId,
  projectIdRaw: projectId,
  sequenceRaw: 17,
  eventTypeRaw: "VerificationConcluded",
  eventVersionRaw: 2,
  occurredAtRaw: occurredAt,
  aggregateRefRaw: verificationId,
  actorRaw: "agent:verifier",
  causedByCommandIdRaw: commandId,
  causedByEventIdRaw: null,
  correlationRefRaw: null,
  payloadJsonRaw: JSON.stringify(payload),
  deadLetterReason: "unsupported eventVersion 2",
} as const;

describe("F18 historical Verification signal reconciliation", () => {
  it("writes fixed root Attention with null EventId for a pre-decode envelope failure", async () => {
    const attentionWrites: Array<Record<string, unknown>> = [];
    const malformed = {
      ...candidate,
      deadLetterReason: "malformed event payload",
      payloadJsonRaw: "not-json",
    };
    const deps = {
      tx: {
        transact: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      },
      store: {
        listDeadLetterCandidates: () => Effect.succeed([malformed]),
        find: () => Effect.succeed(null),
        recordAttention: (input: Record<string, unknown>) =>
          Effect.sync(() => void attentionWrites.push(input)),
      },
      projects: {
        findById: () => Effect.succeed(Option.some({ rootWorkspaceId })),
      },
      workspaces: {
        findById: () =>
          Effect.succeed(Option.some({ projectId, parentWorkspaceId: null })),
      },
      clock: { now: () => Effect.succeed("2026-10-21T00:00:01.000Z") },
    } as never;

    const sweep = await Effect.runPromise(
      runVerificationSignalReconciliationSweep(projectId, deps, {
        leaseOwner: "f18-malformed-test",
        leaseTtlMs: 30_000,
        batchSize: 10,
      }),
    );

    expect(sweep.attention).toBe(1);
    expect(attentionWrites).toEqual([
      expect.objectContaining({
        identity: {
          consumerId: "workflow-signals",
          projectId,
          eventSequence: 17,
        },
        eventId: null,
        failureCode: "EventEnvelopeMalformed",
        targetWorkspaceId: rootWorkspaceId,
        sourceIdentity: `workflow-signals:${projectId}:17`,
      }),
    ]);
  });

  it("proves the v2 receipt and canonical row before idempotent child Inbox/wake convergence", async () => {
    let state: VerificationSignalReconciliationRow | null = null;
    const stateNow = () => state as VerificationSignalReconciliationRow | null;
    let inboxEntry: {
      entry: Record<string, unknown>;
      consumedAt: string | null;
    } | null = null;
    const effects: Array<string> = [];
    let failParentWakeOnce = true;
    let testNow = "2026-10-21T00:00:01.000Z";
    const tx = {
      transact: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    };
    const receipt = {
      commandId,
      projectId,
      semanticRequestFingerprint: "fingerprint" as never,
      schemaVersion: "2",
      fingerprintAlgorithmVersion: 1,
      resolution: "Committed" as const,
      resultJson: JSON.stringify(result),
      terminalErrorJson: null,
      createdAt: occurredAt,
      settledAt: occurredAt,
    };
    const deps = {
      tx,
      store: {
        listDeadLetterCandidates: () => Effect.succeed([candidate]),
        activationHighwater: () => Effect.succeed(null),
        find: () => Effect.succeed(state),
        insertPending: (source: {
          readonly sourceDigest: string;
          readonly effectPlanDigest: string;
        }) =>
          Effect.sync(() => {
            state = {
              consumerId: "workflow-signals",
              projectId,
              eventSequence: 17,
              eventId,
              sourceCommandId: commandId,
              verificationId,
              workId,
              workRevision: 0,
              verdict: "Pass",
              ownerWorkspaceId: childWorkspaceId,
              parentWorkspaceId: rootWorkspaceId,
              sourceDigest: source.sourceDigest,
              effectPlanDigest: source.effectPlanDigest,
              phase: "Pending",
              failureCode: null,
              attentionFactId: null,
              leaseOwner: "f18-test",
              leaseGeneration: 1,
              leaseExpiresAt: "2026-10-21T00:01:00.000Z",
              createdAt: occurredAt,
              updatedAt: occurredAt,
            };
            return state;
          }),
        claim: (input: {
          readonly leaseOwner: string;
          readonly now: string;
          readonly leaseTtlMs: number;
        }) =>
          Effect.sync(() => {
            if (
              state === null ||
              state.leaseExpiresAt === null ||
              Date.parse(state.leaseExpiresAt) > Date.parse(input.now)
            )
              return null;
            state = {
              ...state,
              leaseOwner: input.leaseOwner,
              leaseGeneration: state.leaseGeneration + 1,
              leaseExpiresAt: new Date(
                Date.parse(input.now) + input.leaseTtlMs,
              ).toISOString(),
            };
            return state;
          }),
        advance: (input: {
          readonly nextPhase: VerificationSignalReconciliationRow["phase"];
        }) =>
          Effect.sync(() => {
            if (state === null) return false;
            state = {
              ...state,
              phase: input.nextPhase,
              leaseOwner:
                input.nextPhase === "Completed" ? null : state.leaseOwner,
              leaseExpiresAt:
                input.nextPhase === "Completed" ? null : state.leaseExpiresAt,
            };
            effects.push(`phase:${input.nextPhase}`);
            return true;
          }),
        recordAttention: () =>
          Effect.sync(() => void effects.push("attention")),
      },
      journal: {
        decodeRaw: () =>
          Effect.succeed(
            decodeSupportedEventPayload("VerificationConcluded", 2, payload)
              ._tag === "Decoded"
              ? { _tag: "Decoded", event: {} as never }
              : { _tag: "Poison", reason: "MalformedPayload" as const },
          ),
      },
      commands: { findResolution: () => Effect.succeed(Option.some(receipt)) },
      retryOrigins: { findOrigin: () => Effect.succeed(Option.none()) },
      verifications: {
        findById: () => Effect.succeed(Option.some(verification)),
      },
      works: {
        findById: () =>
          Effect.succeed(Option.some({ workspaceId: childWorkspaceId })),
        listByWorkspace: () => Effect.succeed([]),
      },
      workspaces: {
        findById: (workspaceId: unknown) =>
          Effect.succeed(
            Option.some({
              projectId,
              workspaceId,
              parentWorkspaceId:
                workspaceId === childWorkspaceId ? rootWorkspaceId : null,
            }),
          ),
      },
      projects: {
        findById: () => Effect.succeed(Option.some({ rootWorkspaceId })),
      },
      waits: {
        listActive: () => Effect.succeed([]),
        findByWork: () => Effect.succeed(Option.none()),
        clear: () => Effect.void,
      },
      scheduler: {
        reevaluate: (workspaceId: unknown) =>
          Effect.gen(function* () {
            effects.push(`wake:${workspaceId}`);
            if (failParentWakeOnce) {
              failParentWakeOnce = false;
              return yield* Effect.fail({
                _tag: "InjectedCrashAfterInboxCommit" as const,
              });
            }
            return { _tag: "Idle" as const };
          }),
      },
      inbox: {
        findStoredByKey: () =>
          Effect.succeed(
            inboxEntry === null ? Option.none() : Option.some(inboxEntry),
          ),
        admitUpsert: (entry: Record<string, unknown>) =>
          Effect.sync(() => {
            effects.push("parent-inbox");
            inboxEntry = { entry, consumedAt: null };
          }),
      },
      clock: { now: () => Effect.succeed(testNow) },
    } as never;

    const interrupted = await Effect.runPromiseExit(
      runVerificationSignalReconciliationSweep(projectId, deps, {
        leaseOwner: "f18-test",
        leaseTtlMs: 60_000,
        batchSize: 10,
      }),
    );
    expect(interrupted._tag).toBe("Failure");
    expect(stateNow()?.phase).toBe("ParentInboxCommitted");
    expect(inboxEntry).not.toBeNull();
    testNow = "2026-10-21T00:02:00.000Z";
    const first = await Effect.runPromise(
      runVerificationSignalReconciliationSweep(projectId, deps, {
        leaseOwner: "f18-restart",
        leaseTtlMs: 60_000,
        batchSize: 10,
      }),
    );
    const replay = await Effect.runPromise(
      runVerificationSignalReconciliationSweep(projectId, deps, {
        leaseOwner: "f18-test",
        leaseTtlMs: 60_000,
        batchSize: 10,
      }),
    );

    expect(first.completed).toBe(1);
    expect(first.attention).toBe(0);
    expect(replay.completed).toBe(1);
    expect(stateNow()?.phase).toBe("Completed");
    expect(stateNow()?.leaseGeneration).toBe(2);
    expect(effects).toEqual([
      "phase:VerificationWakeDelivered",
      "parent-inbox",
      "phase:ParentInboxCommitted",
      `wake:${rootWorkspaceId}`,
      `wake:${rootWorkspaceId}`,
      "phase:ParentWakeDelivered",
      "phase:Completed",
    ]);
  });
});
