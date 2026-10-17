import {
  Actor,
  CommandId,
  type CommandReceipt,
  type DomainEvent,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  type Verification,
  VerificationId,
  WorkId,
  WorkRevision,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeRetryVerificationHandler,
  type RetryVerificationPayload,
  type RetryVerificationResult,
} from "../src/commands/retry-verification.js";
import type { CommandRejection } from "../src/rejection.js";

const projectId = parse(ProjectId)("prj_00000000-0000-7000-8000-000000000001");
const principal = parse(Principal)("user:test");
const actor = parse(Actor)("user:test");
const workId = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const sourceId = parse(VerificationId)(
  "ver_00000000-0000-7000-8000-000000000001",
);
const successorId = parse(VerificationId)(
  "ver_00000000-0000-7000-8000-000000000002",
);
const sourceExecutionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000001",
);
const successorExecutionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000002",
);
const commandId = parse(CommandId)("cmd_00000000-0000-7000-8000-000000000001");
const missionSnapshot = {
  goal: "verify the durable outcome",
  criteria: [
    {
      criterionId: "c1",
      requirement: "evidence is inspectable",
      required: true,
    },
  ],
  riskRequirements: [],
};

const source: Verification = {
  verificationId: sourceId,
  workId,
  ownerWorkspaceId: "wsp_00000000-0000-7000-8000-000000000001" as never,
  targetWorkRevision: parse(WorkRevision)(0),
  missionSnapshot,
  criteriaResults: null,
  snapshotStatus: "UnavailableLegacy",
  targetDeliverables: [],
  targetArtifactVersions: [],
  targetEnvironmentRevision: null,
  environmentSnapshotRef: null,
  evidenceRefs: [],
  verificationExecutionIds: [sourceExecutionId],
  summaryRef: "blob:orphan-summary",
  state: {
    status: "Concluded",
    verdict: "Unknown",
    conclusionReason: "Orphaned",
  },
};

const successor: Verification = {
  ...source,
  verificationId: successorId,
  criteriaResults: null,
  snapshotStatus: "Pending",
  verificationExecutionIds: [successorExecutionId],
  summaryRef: null,
  state: { status: "Open" },
};

const payload: RetryVerificationPayload = {
  workId,
  verificationId: sourceId,
  expectedWorkRevision: parse(WorkRevision)(0),
  summaryContent: "The verifier is no longer available.",
  successorVerificationId: successorId,
  verifierExecutionId: successorExecutionId,
};

const startEvent = {
  eventId: "evt_00000000-0000-7000-8000-000000000001",
  projectId,
  sequence: 1,
  eventType: "VerificationStarted",
  eventVersion: 1,
  occurredAt: "t",
  aggregateRef: successorId,
  actor,
  causedByCommandId: commandId,
  payload: {
    verificationId: successorId,
    workId,
    targetWorkRevision: 0,
    missionDigest: "verify the durable outcome [criteria=1 required=1]",
  },
} as unknown as DomainEvent<unknown>;

const conclusionEvent = {
  eventId: "evt_00000000-0000-7000-8000-000000000002",
  projectId,
  sequence: 2,
  eventType: "VerificationConcluded",
  eventVersion: 1,
  occurredAt: "t",
  aggregateRef: sourceId,
  actor,
  causedByCommandId: commandId,
  payload: {
    verificationId: sourceId,
    workId,
    targetWorkRevision: 0,
    verdict: "Unknown",
    conclusionReason: "Orphaned",
    evidenceRefs: [],
    summaryRef: "blob:orphan-summary",
  },
} as unknown as DomainEvent<unknown>;

const receipt: CommandReceipt<RetryVerificationResult, CommandRejection> = {
  commandId,
  projectId,
  semanticRequestFingerprint: "fp" as never,
  schemaVersion: "1",
  fingerprintAlgorithmVersion: 1,
  createdAt: "t",
  settledAt: "t",
  resolution: {
    _tag: "Committed",
    result: {
      workId,
      orphanedVerificationId: sourceId,
      successorVerificationId: successorId,
      verifierExecutionId: successorExecutionId,
      state: "OrphanedAndRetried",
    },
  },
};

const makeHandler = (
  events: ReadonlyArray<DomainEvent<unknown>> = [startEvent, conclusionEvent],
) =>
  makeRetryVerificationHandler({
    works: { findById: () => Effect.succeed(Option.none()) },
    verifications: {
      findById: (id: VerificationId) =>
        Effect.succeed(
          id === sourceId ? Option.some(source) : Option.some(successor),
        ),
      findByExecutionId: () => Effect.succeed(Option.none()),
    },
    executions: { findById: () => Effect.succeed(Option.none()) },
    projects: { findById: () => Effect.succeed(Option.none()) },
    workspaces: { findById: () => Effect.succeed(Option.none()) },
    origins: {
      insertOrigin: () => Effect.void,
      findOrigin: () =>
        Effect.succeed(
          Option.some({
            commandId,
            projectId,
            actor: principal,
            sourceVerificationId: sourceId,
            sourceWorkId: workId,
            successorVerificationId: successorId,
            successorVerifierExecutionId: successorExecutionId,
            createdAt: "t",
          }),
        ),
    },
    journal: {
      lastSequence: () => Effect.succeed(events.length),
      readAfter: () => Effect.succeed(events as never),
    },
    clock: { now: () => Effect.succeed("t") },
    blobs: {
      put: () => Effect.succeed("blob:unused"),
      get: () => Effect.succeed(new Uint8Array()),
    },
    governance: { authenticatedHumans: [], directParentOf: [] },
    start: {} as never,
    conclude: {} as never,
  });

describe("RetryVerification strict historical receipt replay", () => {
  const runReplay = (effect: Effect.Effect<void, unknown, TransactionScope>) =>
    Effect.runPromise(
      Effect.provideService(effect, TransactionScope, {
        session: { id: "retry-replay" },
      }),
    );

  it("accepts an exact v1 receipt only when origin, legacy row and v1 events converge", async () => {
    const handler = makeHandler();
    await expect(
      runReplay(
        handler.validateReceiptReplay?.(
          receipt as never,
          payload,
          {
            commandType: "RetryVerification",
            commandId,
            projectId,
            actor,
            issuedAt: "t",
            payload,
          },
          { _tag: "External", principal },
        ) ?? Effect.void,
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed if the persisted v1 conclusion event conflicts with the legacy row", async () => {
    const conflicting = {
      ...conclusionEvent,
      payload: {
        ...(conclusionEvent.payload as Record<string, unknown>),
        summaryRef: "blob:other",
      },
    } as DomainEvent<unknown>;
    const handler = makeHandler([startEvent, conflicting]);
    await expect(
      runReplay(
        handler.validateReceiptReplay?.(
          receipt as never,
          payload,
          {
            commandType: "RetryVerification",
            commandId,
            projectId,
            actor,
            issuedAt: "t",
            payload,
          },
          { _tag: "External", principal },
        ) ?? Effect.void,
      ),
    ).rejects.toMatchObject({
      _tag: "PersistenceCorruption",
      operation: "retry-verification-replay-binding",
    });
  });
});
