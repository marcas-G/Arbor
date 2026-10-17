import { join } from "node:path";
import { Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
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
  AgentLoopStepStore,
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
import { createSchema46TestDatabase } from "../../support/schema44-database.js";

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
const outputPosition = 0;
const occurrence = `${providerTurnId}:${outputPosition}`;
const expectedEvidenceId = parse(EvidenceId)(
  `evd_${newUuid7("verification-evidence", occurrence)}`,
);
const expectedCommandId = parse(CommandId)(
  `cmd_${newUuid7("record-verification-evidence", occurrence)}`,
);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
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
      loopSteps: yield* AgentLoopStepStore,
      toolInvocations: {
        findById: () =>
          Effect.succeed(
            Option.some({
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
              effectAdmissionState: "MayHaveStarted",
              settledAt: "2026-10-07T00:00:02.000Z",
              settlement: { _tag: "Success" },
              resultRef: null,
            }),
          ),
      } as never,
    };
    return makeSingleWorkspaceControlActionHandlers(dependencies);
  });

describe("pending AH10 RecordVerificationEvidence recordedAt retry fingerprint", () => {
  it("keeps the first durable ActionIntent time across owner-generation takeover", async () => {
    const database = await createSchema46TestDatabase();
    cleanups.push(database.cleanup);
    const directory = database.directory;
    const databaseFile = database.databaseFilename;
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
      const actionIntentAt = "2026-10-07T00:00:01.500Z";
      const loopSteps = yield* AgentLoopStepStore;
      const actionFence = {
        executionId: verifierExecutionId,
        workerId: lease.workerId,
        workerIncarnationId: lease.workerIncarnationId,
        fencingGeneration: lease.generation,
      };
      const actionIdentity = {
        executionId: verifierExecutionId,
        logicalStepNo: 0,
        repairAttempt: 0,
      };
      const preparedStep = yield* tx.transact(
        loopSteps.createPrepared(
          {
            identity: actionIdentity,
            providerTurnId: providerTurnId as never,
            state: "Prepared",
            nextActionIndex: 0,
            revision: 0,
            updatedAt: actionIntentAt,
          },
          actionFence,
        ),
      );
      yield* tx.transact(
        loopSteps.transition(
          {
            identity: actionIdentity,
            expectedRevision: preparedStep.revision,
            expectedState: "Prepared",
            next: {
              ...preparedStep,
              state: "ActionsInProgress",
              revision: preparedStep.revision + 1,
              updatedAt: "2026-10-07T00:00:01.250Z",
            },
          },
          actionFence,
        ),
      );
      yield* tx.transact(
        loopSteps.createAction(
          {
            identity: actionIdentity,
            actionIndex: outputPosition,
            logicalActionId: "lac_record_evidence",
            callRef: "control-record-evidence",
            routeKind: "Control",
            actionKind: "arbor_record_verification_evidence",
            inputHash:
              "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            state: "Pending",
            revision: 0,
            updatedAt: actionIntentAt,
          },
          actionFence,
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
      };
      const first = yield* Effect.exit(handler.handle(input as never));
      yield* tx.transact(
        leaseService.release(
          verifierExecutionId,
          lease.workerId,
          lease.workerIncarnationId,
          lease.generation,
        ),
      );
      const takeoverLease = yield* tx.transact(
        leaseService.acquire(
          verifierExecutionId,
          "worker:verifier-takeover",
          "incarnation:record-at-takeover",
        ),
      );
      const second = yield* Effect.exit(
        handler.handle({
          ...input,
          context: {
            ...input.context,
            fencingGeneration: takeoverLease.generation,
            workerId: takeoverLease.workerId,
            workerIncarnationId: takeoverLease.workerIncarnationId,
          },
        } as never),
      );

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
          recordedAt: actionIntentAt,
        },
      };
      const secondPayload = firstPayload;
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
    expect(result.clockValues).toHaveLength(2);
    expect(result.firstFingerprint).toBe(result.secondFingerprint);
    expect(result.receipt).toMatchObject({
      command_id: expectedCommandId,
      resolution: "Committed",
      semantic_request_fingerprint: result.firstFingerprint,
    });
    expect(result.evidence).toHaveLength(1);
    expect(Exit.isSuccess(result.second)).toBe(true);
  });
});
