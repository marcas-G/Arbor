import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  P32_MIGRATIONS,
  runMigrations,
} from "../../../adapters/persistence-sqlite/src/index.js";
import { makeSingleWorkspaceControlActionHandlers } from "../../../apps/single-workspace/src/control-actions.js";
import { buildSingleWorkspaceLayer } from "../../../apps/single-workspace/src/index.js";
import {
  CommandGateway,
  newUuid7,
  semanticRequestFingerprint,
} from "../../../packages/application/src/index.js";
import {
  CommandId,
  EvidenceId,
  ExecutionId,
  parse,
  startVerification,
  ToolInvocationId,
  VerificationId,
  WorkRevision,
} from "../../../packages/domain/src/index.js";
import {
  AcceptanceRepository,
  BlobStorePort,
  CommandStore,
  DecisionRequestStore,
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  EvidenceRepository,
  ExecutionRepository,
  FormationProposalStore,
  IdGenerator,
  InboxProjectionStore,
  LeaseService,
  LocalPlanStore,
  MessageStore,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootSession,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "../../support/p7-app.js";

const sourceWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789d1" as never;
const verifierExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const verificationId = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const toolInvocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const evidenceSourceCallRef = "tool-call-recorded-at";
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789d1";
const outputPosition = 3;
const occurrence = `${providerTurnId}:${outputPosition}`;
const expectedEvidenceId = parse(EvidenceId)(
  `evd_${newUuid7("verification-evidence", occurrence)}`,
);
const expectedCommandId = parse(CommandId)(
  `cmd_${newUuid7("record-verification-evidence", occurrence)}`,
);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const recordDependencies = (clock: { now: () => Effect.Effect<string> }) =>
  Effect.gen(function* () {
    const dependencies = {
      gateway: yield* CommandGateway,
      blobs: yield* BlobStorePort,
      clock,
      messages: yield* MessageStore,
      tx: yield* TransactionPort,
      works: yield* WorkRepository,
      workspaces: yield* WorkspaceRepository,
      proposals: yield* FormationProposalStore,
      inbox: yield* InboxProjectionStore,
      waits: yield* WorkWaitStore,
      dependencyRecords: yield* DependencyRepository,
      acceptances: yield* AcceptanceRepository,
      deliverables: yield* DeliverableRepository,
      journal: yield* DomainEventJournal,
      ids: yield* IdGenerator,
      commandReceipts: yield* CommandStore,
      plans: yield* LocalPlanStore,
      decisions: yield* DecisionRequestStore,
      verifications: yield* VerificationRepository,
      sessions: yield* SessionRepository,
      toolInvocations: yield* ToolInvocationStore,
    };
    return makeSingleWorkspaceControlActionHandlers(dependencies);
  });

describe("pending AH10 RecordVerificationEvidence recordedAt retry fingerprint", () => {
  it("replays one CommandId for the same action without changing its committed fingerprint", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "ah10-record-evidence-fingerprint-"),
    );
    directories.push(directory);
    const databaseFile = join(directory, "arbor.db");
    const app = buildSingleWorkspaceLayer({
      databaseFile,
      blobRoot: join(directory, "blobs"),
    });
    const clockValues: string[] = [];
    let clockSequence = 0;
    const clock = {
      now: () =>
        Effect.sync(() => {
          const value = `recorded-at-${++clockSequence}`;
          clockValues.push(value);
          return value;
        }),
    };

    const program = Effect.gen(function* () {
      yield* runMigrations(P32_MIGRATIONS);
      yield* p7SeedProject;
      const workReceipt = yield* p7SeedWork(
        sourceWorkId,
        parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d1"),
      );
      expect(workReceipt.resolution._tag).toBe("Committed");

      const tx = yield* TransactionPort;
      const executions = yield* ExecutionRepository;
      const leaseService = yield* LeaseService;
      const verifierExecution = {
        executionId: verifierExecutionId,
        projectId: p7Project,
        workspaceId: p7RootWorkspace,
        binding: {
          _tag: "ExecutionBoundAgentBinding",
          parentExecutionId: null,
          mission: "verification-action-fingerprint",
        },
        sessionId: p7RootSession,
        admittedAt: "2026-10-07T00:00:00.000Z",
        stopRequestedAt: null,
        state: { status: "Active", settlement: null },
      } as never;
      yield* tx.transact(executions.admitExecution(verifierExecution));
      const lease = yield* tx.transact(
        leaseService.acquire(
          verifierExecutionId,
          "worker:verifier",
          "incarnation:record-at",
        ),
      );

      const verifications = yield* VerificationRepository;
      const verification = startVerification({
        verificationId,
        workId: sourceWorkId,
        targetWorkRevision: parse(WorkRevision)(0),
        missionSnapshot: {
          goal: "verify a tool result",
          criteria: [
            {
              criterionId: "criterion-1",
              requirement: "result is observed",
              required: true,
            },
          ],
          riskRequirements: [],
        },
        verificationExecutionIds: [verifierExecutionId],
      });
      yield* tx.transact(
        verifications.insert(verification, p7Project, p7RootWorkspace),
      );
      yield* tx.transact(
        verifications.bindExecution(verificationId, verifierExecutionId, "t"),
      );

      const invocationStore = yield* ToolInvocationStore;
      yield* tx.transact(
        invocationStore.recordIntent({
          invocationId: toolInvocationId,
          executionId: verifierExecutionId,
          workspaceId: p7RootWorkspace,
          toolName: "read",
          toolVersion: "1",
          sideEffectSemantics: "ReadOnly",
          argumentsJson: "{}",
          resolvedRegions: [],
          approvalId: null,
          intentAt: "2026-10-07T00:00:01.000Z",
        }),
      );
      yield* tx.transact(
        invocationStore.settle(
          toolInvocationId,
          { _tag: "Success" },
          null,
          "2026-10-07T00:00:02.000Z",
        ),
      );
      const sessions = yield* SessionRepository;
      yield* tx.transact(
        sessions.appendEntry(p7RootSession, {
          entryKind: "Observation",
          payload: {
            _tag: "ToolResult",
            callRef: evidenceSourceCallRef,
            invocationId: toolInvocationId,
            observationRef: "observation:stable-source",
            status: "Succeeded",
          },
        }),
      );

      const handlers = yield* recordDependencies(clock);
      const handler = handlers.find(
        (candidate) => candidate.action === "RecordVerificationEvidence",
      );
      if (handler === undefined)
        throw new Error("record evidence handler missing");
      const input = {
        action: {
          _tag: "RecordVerificationEvidence",
          criterionId: "criterion-1",
          sourceCallRef: evidenceSourceCallRef,
        },
        invocation: {
          providerTurnId: providerTurnId as never,
          outputPosition,
          callRef: "control-record-evidence",
          toolName: "arbor_record_verification_evidence",
          argumentsJson: "{}",
        },
        execution: verifierExecution,
        context: {
          _tag: "ExecutionOrigin",
          principal: p7TestPrincipal,
          executionId: verifierExecutionId,
          fencingGeneration: lease.generation,
          workerId: lease.workerId,
          workerIncarnationId: lease.workerIncarnationId,
        },
      } as never;
      const first = yield* Effect.exit(handler.handle(input));
      const second = yield* Effect.exit(handler.handle(input));

      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{
        command_id: string;
        resolution: string;
        semantic_request_fingerprint: string;
      }>(
        "SELECT command_id, resolution, semantic_request_fingerprint FROM commands WHERE command_id = ?",
        [expectedCommandId],
      );
      const evidence = yield* tx.transact(
        (yield* EvidenceRepository).listByVerification(verificationId),
      );
      const firstPayload = {
        verificationId,
        evidence: {
          evidenceId: expectedEvidenceId,
          criterionId: "criterion-1",
          kind: "ToolObservation",
          toolInvocationId,
          observationRef: "observation:stable-source",
          callRef: evidenceSourceCallRef,
          recordedAt: clockValues[0],
        },
      };
      const secondPayload = {
        ...firstPayload,
        evidence: { ...firstPayload.evidence, recordedAt: clockValues[2] },
      };
      const firstFingerprint = semanticRequestFingerprint({
        commandType: "RecordVerificationEvidence",
        projectId: p7Project,
        actor: p7TestActor,
        schemaVersion: "1",
        payload: firstPayload,
      });
      const secondFingerprint = semanticRequestFingerprint({
        commandType: "RecordVerificationEvidence",
        projectId: p7Project,
        actor: p7TestActor,
        schemaVersion: "1",
        payload: secondPayload,
      });
      return {
        first,
        second,
        clockValues,
        firstFingerprint,
        secondFingerprint,
        receipt: rows[0],
        evidence,
      };
    });

    const result = await Effect.runPromise(
      Effect.scoped(Effect.provide(program, app as never)) as Effect.Effect<
        Effect.Success<typeof program>,
        unknown,
        never
      >,
    );
    expect(Exit.isSuccess(result.first)).toBe(true);
    expect(result.clockValues[0]).not.toBe(result.clockValues[2]);
    expect(result.firstFingerprint).not.toBe(result.secondFingerprint);
    expect(result.receipt).toMatchObject({
      command_id: expectedCommandId,
      resolution: "Committed",
      semantic_request_fingerprint: result.firstFingerprint,
    });
    expect(result.evidence).toHaveLength(1);
    expect(JSON.stringify(result.second)).toContain("IdempotencyConflict");

    // P1 07: retrying the same immutable CommandId for the same logical action
    // must preserve its fingerprint and converge the committed receipt.
    expect(Exit.isSuccess(result.second)).toBe(true);
  });
});
