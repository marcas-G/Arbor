import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Option } from "effect";
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
} from "../../../packages/application/src/index.js";
import {
  CommandId,
  EvidenceId,
  ExecutionId,
  parse,
  startVerification,
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
  p7TestPrincipal,
} from "../../support/p7-app.js";

const sourceWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789d2" as never;
const verifierExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const verificationId = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const evidenceA = parse(EvidenceId)("evd_018f2b3c-4d5e-7abc-8def-0123456789d1");
const evidenceB = parse(EvidenceId)("evd_018f2b3c-4d5e-7abc-8def-0123456789d2");
const evidenceIds = [evidenceA, evidenceB];
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789d2";
const outputPosition = 4;
const occurrence = `${providerTurnId}:${outputPosition}`;
const expectedCommandId = parse(CommandId)(
  `cmd_${newUuid7("conclude-verification", occurrence)}`,
);
const criteriaResults = [
  {
    criterionId: "criterion-a",
    requirement: "first criterion passes",
    required: true,
    verdict: "Pass" as const,
    evidenceRefs: [evidenceA],
  },
  {
    criterionId: "criterion-b",
    requirement: "second criterion fails",
    required: true,
    verdict: "Fail" as const,
    evidenceRefs: [evidenceB],
  },
];

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const concludeDependencies = (clock: { now: () => Effect.Effect<string> }) =>
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

describe("pending P8 durable ConcludeVerification criterion snapshot", () => {
  it("persists every criterion result in the concluded Verification snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p8-criteria-snapshot-"));
    directories.push(directory);
    const app = buildSingleWorkspaceLayer({
      databaseFile: join(directory, "arbor.db"),
      blobRoot: join(directory, "blobs"),
    });
    const clock = {
      now: () => Effect.succeed("2026-10-07T00:00:00.000Z"),
    };

    const program = Effect.gen(function* () {
      yield* runMigrations(P32_MIGRATIONS);
      yield* p7SeedProject;
      const workReceipt = yield* p7SeedWork(
        sourceWorkId,
        parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d2"),
      );
      expect(workReceipt.resolution._tag).toBe("Committed");

      const tx = yield* TransactionPort;
      const executions = yield* ExecutionRepository;
      const leases = yield* LeaseService;
      const verifierExecution = {
        executionId: verifierExecutionId,
        projectId: p7Project,
        workspaceId: p7RootWorkspace,
        binding: {
          _tag: "ExecutionBoundAgentBinding",
          parentExecutionId: null,
          mission: "verification-criteria-snapshot",
        },
        sessionId: p7RootSession,
        admittedAt: "2026-10-07T00:00:00.000Z",
        stopRequestedAt: null,
        state: { status: "Active", settlement: null },
      } as never;
      yield* tx.transact(executions.admitExecution(verifierExecution));
      const lease = yield* tx.transact(
        leases.acquire(
          verifierExecutionId,
          "worker:verifier",
          "incarnation:criteria-snapshot",
        ),
      );

      const verifications = yield* VerificationRepository;
      const evidence = yield* EvidenceRepository;
      yield* tx.transact(
        verifications.insert(
          startVerification({
            verificationId,
            workId: sourceWorkId,
            targetWorkRevision: parse(WorkRevision)(0),
            missionSnapshot: {
              goal: "verify two independent criteria",
              criteria: criteriaResults.map(
                ({ criterionId, requirement, required }) => ({
                  criterionId,
                  requirement,
                  required,
                }),
              ),
              riskRequirements: [],
            },
            verificationExecutionIds: [verifierExecutionId],
          }),
          p7Project,
          p7RootWorkspace,
        ),
      );
      yield* tx.transact(
        verifications.bindExecution(verificationId, verifierExecutionId, "t"),
      );
      for (const [index, result] of criteriaResults.entries()) {
        const evidenceId = evidenceIds[index];
        if (evidenceId === undefined)
          throw new Error("evidence fixture missing");
        yield* tx.transact(
          evidence.append({
            evidenceId,
            verificationId,
            criterionId: result.criterionId,
            kind: "ReasoningTrace",
            artifactRef: null,
            observedEnvironmentRevision: null,
            recordedByExecutionId: verifierExecutionId,
            recordedAt: `2026-10-07T00:00:0${index}.000Z`,
          }),
        );
      }

      const handlers = yield* concludeDependencies(clock);
      const handler = handlers.find(
        (candidate) => candidate.action === "ConcludeVerification",
      );
      if (handler === undefined) throw new Error("conclude handler missing");
      const actionExit = yield* Effect.exit(
        handler.handle({
          action: {
            _tag: "ConcludeVerification",
            verdict: "Fail",
            criteriaResults,
            summary: "Criterion A passed; criterion B failed.",
          },
          invocation: {
            providerTurnId: providerTurnId as never,
            outputPosition,
            callRef: "control-conclude-verification",
            toolName: "arbor_conclude_verification",
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
        } as never),
      );

      const found = yield* tx.transact(verifications.findById(verificationId));
      const verification = Option.isSome(found) ? found.value : undefined;
      const sql = yield* SqlClient;
      const commandRows = yield* sql.unsafe<{
        resolution: string;
        result_json: string | null;
      }>("SELECT resolution, result_json FROM commands WHERE command_id = ?", [
        expectedCommandId,
      ]);
      const eventRows = yield* sql.unsafe<{ payload_json: string }>(
        "SELECT payload_json FROM domain_events WHERE event_type = 'VerificationConcluded' AND aggregate_ref = ?",
        [verificationId],
      );
      const evidenceRows = yield* tx.transact(
        evidence.listByVerification(verificationId),
      );
      const eventPayload = eventRows[0]
        ? (JSON.parse(eventRows[0].payload_json) as Record<string, unknown>)
        : null;
      const commandResult = commandRows[0]?.result_json
        ? (JSON.parse(commandRows[0].result_json) as Record<string, unknown>)
        : null;
      const persistedCriteriaResults = (
        verification as unknown as
          | { readonly criteriaResults?: unknown }
          | undefined
      )?.criteriaResults;
      return {
        actionExit,
        verification,
        persistedCriteriaResults: persistedCriteriaResults ?? null,
        commandResolution: commandRows[0]?.resolution,
        commandResult,
        eventPayload,
        evidenceCriterionIds: evidenceRows.map((row) => row.criterionId),
      };
    });

    const result = await Effect.runPromise(
      Effect.scoped(Effect.provide(program, app as never)) as Effect.Effect<
        Effect.Success<typeof program>,
        unknown,
        never
      >,
    );
    expect(Exit.isSuccess(result.actionExit)).toBe(true);
    expect(result.commandResolution).toBe("Committed");
    expect(result.verification).toMatchObject({
      summaryRef: expect.any(String),
      state: { status: "Concluded", verdict: "Fail" },
    });
    expect(result.evidenceCriterionIds).toEqual(["criterion-a", "criterion-b"]);
    expect(result.eventPayload).toMatchObject({
      verdict: "Fail",
      evidenceRefs: evidenceIds,
      summaryRef: result.verification?.summaryRef,
    });
    expect(result.commandResult).toMatchObject({
      verdict: "Fail",
      summaryRef: result.verification?.summaryRef,
    });
    expect(result.eventPayload).not.toHaveProperty("criteriaResults");
    expect(result.commandResult).not.toHaveProperty("criteriaResults");

    // P8 `04` §2 freezes this criterion-level conclusion snapshot as durable
    // Verification truth. Current row/store has only mission + aggregate verdict.
    expect(result.persistedCriteriaResults).toEqual(criteriaResults);
  });
});
