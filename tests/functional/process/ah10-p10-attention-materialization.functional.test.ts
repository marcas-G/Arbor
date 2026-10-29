import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AttentionPollStoreLive,
  AttentionProjectionStoreLive,
  ClockLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  CURRENT_SCHEMA_VERSION,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeProjectAttentionProjectionStore,
  makeRecoveryAttentionFactStoreLive,
  P10_ATTENTION_CONSUMER_ID,
  P37_MIGRATIONS,
  ProjectionStoreLive,
  rebuildProjection,
  runMigrations,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import { makeP51ActivationHighwaterFact } from "../../../adapters/persistence-sqlite/src/p51-verification-v2-consumer-reconciliation-migration.js";
import { buildSingleWorkspaceLayer } from "../../../apps/single-workspace/src/index.js";
import type {
  AttentionReq,
  AttentionRes,
  TreeViewReq,
  TreeViewRes,
} from "../../../packages/api-contracts/src/views.js";
import { runAttentionPollOnce } from "../../../packages/application/src/attention-poll-loop.js";
import { pollOnce } from "../../../packages/application/src/consumer-loop.js";
import {
  CommandId,
  ExecutionId,
  ProjectId,
  parse,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import {
  AttentionPollStore,
  AttentionProjectionStore,
  Clock,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DomainEventJournal,
  ProjectionQueryPort,
  ProjectionStore,
  RecoveryAttentionFactStore,
  TransactionPort,
} from "../../../packages/ports/src/index.js";
import { subtreeAttentionAggregate } from "../../../packages/projection-runtime/src/attention.js";
import type { AttentionReadDeps } from "../../../packages/projection-runtime/src/attention-loader.js";
import { deriveProjectAttention } from "../../../packages/projection-runtime/src/attention-loader.js";
import { projectionReadError } from "../../../packages/projection-runtime/src/errors.js";
import {
  upgradeSchema44TestDatabase,
  upgradeSchema44ToCurrentTestDatabase,
} from "../../support/schema44-database.js";
import {
  createFunctionalFixtureDirectory,
  removeFunctionalFixtureDirectory,
} from "../support/schema44-bootstrap.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ac");
const parentWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789ac";
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ac");
const logicalActionId = "act_018f2b3c-4d5e-7abc-8def-0123456789ac";
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789ac";
const consumerId = P10_ATTENTION_CONSUMER_ID;
const firstFixture = {
  projectId,
  parentWorkspaceId,
  sessionId,
  executionId,
  commandId,
  logicalActionId,
  workId,
};
const secondFixture = {
  projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ad"),
  parentWorkspaceId: parse(WorkspaceId)(
    "ws_018f2b3c-4d5e-7abc-8def-0123456789ad",
  ),
  sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789ad",
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789ad"),
  commandId: parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ad"),
  logicalActionId: "act_018f2b3c-4d5e-7abc-8def-0123456789ad",
  workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789ad",
};
const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const p10DaemonChild = join(
  repositoryRoot,
  "tests",
  "functional",
  "support",
  "p10-attention-daemon-child.mjs",
);

const makeApp = (filename = ":memory:") => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    journal,
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(AttentionPollStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
    Layer.provide(ProjectionStoreLive, infra),
    Layer.provide(AttentionProjectionStoreLive, infra),
    Layer.provide(
      makeRecoveryAttentionFactStoreLive(),
      Layer.mergeAll(infra, journal),
    ),
  );
  return Layer.mergeAll(infra, stores);
};

const upgradeHistoricalAttentionFixtureToSchema51 = async (
  databaseFile: string,
  directory: string,
) => {
  await upgradeSchema44TestDatabase({
    databaseFilename: databaseFile,
    p39ReportFilename: join(directory, "p39-report.sqlite"),
  });
  const schema44 = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    expect(
      Number(
        (
          schema44.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(44);
  } finally {
    schema44.close();
  }

  await upgradeSchema44ToCurrentTestDatabase({
    databaseFilename: databaseFile,
  });
  const currentSchema = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    expect(CURRENT_SCHEMA_VERSION).toBe(54);
    expect(
      Number(
        (
          currentSchema.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(54);
    expect(currentSchema.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const projects = currentSchema
      .prepare(
        `SELECT project.project_id,
                COALESCE(sequence.last_sequence, 0) AS max_event_sequence
           FROM projects AS project
           LEFT JOIN project_event_sequences AS sequence USING (project_id)
          ORDER BY project.project_id`,
      )
      .all() as Array<{ project_id: string; max_event_sequence: number }>;
    const highwaters = currentSchema
      .prepare(
        `SELECT project_id, max_event_sequence, captured_at, fact_digest
           FROM verification_conclusion_v2_activation_highwaters
          ORDER BY project_id`,
      )
      .all() as Array<{
      project_id: string;
      max_event_sequence: number;
      captured_at: string;
      fact_digest: string;
    }>;
    expect(highwaters).toHaveLength(projects.length);
    for (const project of projects) {
      const highwater = highwaters.find(
        (candidate) => candidate.project_id === project.project_id,
      );
      expect(highwater).toBeDefined();
      if (highwater === undefined) continue;
      expect(highwater).toMatchObject({
        max_event_sequence: Number(project.max_event_sequence),
        fact_digest: makeP51ActivationHighwaterFact(
          project.project_id,
          Number(project.max_event_sequence),
          highwater.captured_at,
        ).factDigest,
      });
    }
  } finally {
    currentSchema.close();
  }
};

const seedSourceOwner = (fixture: typeof firstFixture | typeof secondFixture) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const sql = yield* SqlClient;
    yield* tx.transact(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `INSERT INTO projects (
            project_id, name, root_workspace_id, project_policy,
            project_policy_revision, default_configuration, environment_ref,
            lifecycle, revision, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            fixture.projectId,
            "Attention materialization fixture",
            fixture.parentWorkspaceId,
            "{}",
            0,
            "{}",
            "environment:test",
            "Open",
            0,
            "t0",
            "t0",
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO sessions (
            session_id, binding_kind, workspace_id, execution_id,
            context_epoch, created_at
          ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
          [fixture.sessionId, fixture.parentWorkspaceId],
        );
        yield* sql.unsafe(
          `INSERT INTO workspaces (
            workspace_id, project_id, parent_workspace_id, name,
            responsibility_definition, responsibility_revision,
            resource_boundary, resource_boundary_revision, agent_binding,
            primary_session_id, current_work_id, workspace_policy,
            workspace_policy_revision, revision, lifecycle, created_at, updated_at
          ) VALUES (?, ?, NULL, 'Parent', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
          [fixture.parentWorkspaceId, fixture.projectId, fixture.sessionId],
        );
        yield* sql.unsafe(
          `INSERT INTO works (
            work_id, project_id, workspace_id, objective, why, constraints,
            completion_expectation, verification_mission, provenance,
            lifecycle, revision, created_at, updated_at
          ) VALUES (?, ?, ?, 'attention source', 'fixture', '[]', 'green', '{}', '{}', 'Open', 0, 't0', 't0')`,
          [fixture.workId, fixture.projectId, fixture.parentWorkspaceId],
        );
        yield* sql.unsafe(
          `INSERT INTO commands (
            command_id, project_id, semantic_request_fingerprint,
            schema_version, fingerprint_algorithm_version, resolution,
            result_json, terminal_error_json, created_at, settled_at
          ) VALUES (?, ?, 'fixture', '1', 1, 'Committed', '{}', NULL, 't0', 't0')`,
          [fixture.commandId, fixture.projectId],
        );
        yield* sql.unsafe(
          `INSERT INTO executions (
            execution_id, project_id, binding_kind, workspace_id,
            episode_kind, episode_ref, episode_revision, parent_execution_id,
            mission, session_id, admitted_at, stop_requested_at,
            settlement_kind, settlement_json, settled_at
          ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 0, NULL, NULL, ?, 't0', NULL, NULL, NULL, NULL)`,
          [
            fixture.executionId,
            fixture.projectId,
            fixture.parentWorkspaceId,
            fixture.workId,
            fixture.sessionId,
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO agent_execution_state (
            execution_id, episode_json, wake_reason, current_mode,
            active_skill_refs_json, turn_no, recent_directive_refs_json,
            recent_action_fingerprints_json, updated_at
          ) VALUES (?, ?, 'Seed', NULL, '[]', 0, '[]', '[]', 't0')`,
          [
            fixture.executionId,
            JSON.stringify({
              _tag: "WorkEpisode",
              workId: fixture.workId,
              targetWorkRevision: 0,
            }),
          ],
        );
      }),
    );
  });

const seedP9FailureFactAndEvent = (
  fixture: typeof firstFixture | typeof secondFixture,
  targetLogicalActionId = fixture.logicalActionId,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const source = yield* RecoveryAttentionFactStore;
    return yield* tx.transact(
      source.recordAssignWorkBindingFailure({
        projectId: fixture.projectId,
        executionId: fixture.executionId,
        targetWorkspaceId: fixture.parentWorkspaceId,
        logicalActionId: targetLogicalActionId,
        committedCommandId: fixture.commandId,
        failureCode: "MissingBinding",
        firstDetectedAt: "2026-10-10T00:00:00.000Z",
      }),
    );
  });

const seedP9DeliverReplayFailure = () =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const source = yield* RecoveryAttentionFactStore;
    return yield* tx.transact(
      source.recordDeliverReplayFailure({
        projectId,
        executionId,
        targetWorkspaceId: parentWorkspaceId,
        logicalActionId,
        messageId: "msg_018f2b3c-4d5e-7abc-8def-0123456789ac",
        failureCode: "LegacyMessageMissingEvent",
        firstDetectedAt: "2026-10-10T00:00:00.000Z",
      }),
    );
  });

const readOffset = (targetProjectId = projectId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const offsets = yield* ConsumerOffsetStore;
    return yield* tx.transact(offsets.read(consumerId, targetProjectId));
  });

const readAttentionRows = (targetProjectId = projectId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const attention = yield* AttentionProjectionStore;
    return yield* tx.transact(
      attention.listAssignWorkBindingFailures(targetProjectId),
    );
  });

const readDeliverAttentionRows = (targetProjectId = projectId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const attention = yield* AttentionProjectionStore;
    return yield* tx.transact(
      attention.listDeliverReplayFailures(targetProjectId),
    );
  });

const readMaterializedAttentionView = (targetProjectId = projectId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const attention = yield* AttentionProjectionStore;
    const sourceFacts = yield* RecoveryAttentionFactStore;
    const journal = yield* DomainEventJournal;
    const sql = yield* SqlClient;
    const deps: AttentionReadDeps = {
      listWorkspacesByProject: () => Effect.succeed([]),
      listWorksByWorkspace: () => Effect.succeed([]),
      listExecutionSettlementFacts: () => Effect.succeed([]),
      listAttentionSourceExecutionBindings: (targetProjectId, executionIds) =>
        Effect.gen(function* () {
          const bindings = [];
          for (const sourceExecutionId of executionIds) {
            const fixture = [firstFixture, secondFixture].find(
              (candidate) =>
                candidate.executionId === sourceExecutionId &&
                candidate.projectId === targetProjectId,
            );
            if (fixture === undefined) continue;
            const workRows = yield* sql.unsafe<{
              readonly project_id: string;
              readonly workspace_id: string;
              readonly revision: number;
            }>(
              "SELECT project_id, workspace_id, revision FROM works WHERE work_id = ?",
              [fixture.workId],
            );
            const work = workRows[0];
            if (work === undefined) continue;
            bindings.push({
              executionId: sourceExecutionId,
              projectId: targetProjectId,
              workspaceId: fixture.parentWorkspaceId,
              episodeJson: JSON.stringify({
                _tag: "WorkEpisode",
                workId: fixture.workId,
                targetWorkRevision: 0,
              }),
              workId: fixture.workId,
              workProjectId: work.project_id as never,
              workWorkspaceId: work.workspace_id as never,
              workRevision: Number(work.revision),
            });
          }
          return bindings;
        }).pipe(Effect.mapError(projectionReadError)),
      listOpenVerifications: () => Effect.succeed([]),
      listUnsatisfiedDependencies: () => Effect.succeed([]),
      findDependency: () => Effect.succeed(Option.none()),
      readEvents: (projectIdValue) =>
        tx
          .transact(
            Effect.gen(function* () {
              const last = yield* journal.lastSequence(projectIdValue);
              return last === 0
                ? []
                : yield* journal.readAfter(projectIdValue, 0, last);
            }),
          )
          .pipe(Effect.mapError(projectionReadError)),
      findAssignWorkBindingFailure: (attentionFactId) =>
        tx
          .transact(sourceFacts.findAssignWorkBindingFailure(attentionFactId))
          .pipe(Effect.mapError(projectionReadError)),
      listProjectedAssignWorkBindingFailures: (projectIdValue) =>
        tx
          .transact(attention.listAssignWorkBindingFailures(projectIdValue))
          .pipe(Effect.mapError(projectionReadError)),
      listProjectedDeliverReplayFailures: (projectIdValue) =>
        tx
          .transact(attention.listDeliverReplayFailures(projectIdValue))
          .pipe(Effect.mapError(projectionReadError)),
    };
    return yield* deriveProjectAttention(targetProjectId, deps);
  });

const runP37AttentionPoll = () =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const clock = yield* Clock;
    const journal = yield* DomainEventJournal;
    const offsets = yield* ConsumerOffsetStore;
    const deadLetters = yield* ConsumerDeadLetterStore;
    const pollStore = yield* AttentionPollStore;
    const attentionRows = yield* AttentionProjectionStore;
    const sourceFacts = yield* RecoveryAttentionFactStore;
    return yield* runAttentionPollOnce(
      consumerId,
      {
        leaseOwner: "p37-attention-functional-test",
        leaseTtlMs: 30_000,
        eventBatchSize: 10,
        queueBatchSize: 64,
        baseBackoffMs: 1_000,
        maxBackoffMs: 60_000,
        backoffExponentCap: 6,
      },
      {
        tx,
        clock,
        journal,
        offsets,
        deadLetters,
        pollStore,
        recoveryFacts: sourceFacts,
        attentionRows,
        projectionForProject: (projectIdValue) =>
          makeProjectAttentionProjectionStore(
            projectIdValue,
            sourceFacts,
            attentionRows,
          ),
      },
    );
  });

const runP10AttentionPoll = (targetProjectId = projectId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    const offsets = yield* ConsumerOffsetStore;
    const deadLetters = yield* ConsumerDeadLetterStore;
    const attentionRows = yield* AttentionProjectionStore;
    const sourceFacts = yield* RecoveryAttentionFactStore;
    return yield* pollOnce(consumerId, targetProjectId, 10, {
      tx,
      journal,
      offsets,
      deadLetters,
      projection: makeProjectAttentionProjectionStore(
        targetProjectId,
        sourceFacts,
        attentionRows,
      ),
      handlers: () => Effect.succeed([]),
    });
  });

const rebuildP10Attention = (targetProjectId = projectId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    const offsets = yield* ConsumerOffsetStore;
    const deadLetters = yield* ConsumerDeadLetterStore;
    const sql = yield* SqlClient;
    const attentionRows = yield* AttentionProjectionStore;
    const sourceFacts = yield* RecoveryAttentionFactStore;
    const p10Projection = makeProjectAttentionProjectionStore(
      targetProjectId,
      sourceFacts,
      attentionRows,
    );
    return yield* rebuildProjection(consumerId, targetProjectId).pipe(
      Effect.provideService(TransactionPort, tx),
      Effect.provideService(DomainEventJournal, journal),
      Effect.provideService(ConsumerOffsetStore, offsets),
      Effect.provideService(ConsumerDeadLetterStore, deadLetters),
      Effect.provideService(ProjectionStore, p10Projection),
      Effect.provideService(SqlClient, sql),
    );
  });

const startDaemonChildUntilMarker = async (
  databaseFile: string,
  targetProjectId: string,
  mode: "hold-before-commit" | "hold-after-poll",
  markerFile: string,
) => {
  const child = spawn(
    process.execPath,
    [p10DaemonChild, databaseFile, targetProjectId, mode, markerFile],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  const retainTail = (current: string, chunk: string) =>
    `${current}${chunk}`.slice(-16_384);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = retainTail(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = retainTail(stderr, chunk);
  });
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const startedAt = Date.now();
  while (!existsSync(markerFile)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const status = await closed;
      throw new Error(
        `daemon child exited before marker (${String(status.code)}/${String(status.signal)})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    if (Date.now() - startedAt > 60_000) {
      child.kill("SIGKILL");
      const status = await closed;
      throw new Error(
        `timed out waiting for daemon marker ${markerFile} (exit ${String(status.code)}/${String(status.signal)})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, marker: readFileSync(markerFile, "utf8") };
};

const killDaemonChild = async (child: ReturnType<typeof spawn>) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
};

const inspectFileProjectionState = (databaseFile: string) => {
  const program = Effect.gen(function* () {
    const sql = yield* SqlClient;
    return {
      firstOffset: yield* readOffset(firstFixture.projectId),
      secondOffset: yield* readOffset(secondFixture.projectId),
      firstRows: yield* readAttentionRows(firstFixture.projectId),
      secondRows: yield* readAttentionRows(secondFixture.projectId),
      secondProjectP1Markers: yield* sql.unsafe<{ sequence: number }>(
        "SELECT sequence FROM projection_state WHERE project_id = ? ORDER BY sequence",
        [secondFixture.projectId],
      ),
    };
  });
  return Effect.runPromise(
    Effect.scoped(Effect.provide(program, makeApp(databaseFile))),
  );
};

const queryPublicAttentionAndTree = async (databaseFile: string) => {
  const app = buildSingleWorkspaceLayer({
    databaseFile,
    projectId: firstFixture.projectId,
  });
  const program = Effect.gen(function* () {
    const queries = yield* ProjectionQueryPort;
    const firstAttention = yield* queries.query<AttentionReq, AttentionRes>(
      "attention",
      { projectId: firstFixture.projectId },
    );
    const secondAttention = yield* queries.query<AttentionReq, AttentionRes>(
      "attention",
      { projectId: secondFixture.projectId },
    );
    const tree = yield* queries.query<TreeViewReq, TreeViewRes>(
      "responsibility-tree",
      { projectId: firstFixture.projectId },
    );
    return {
      firstAttention: firstAttention.value.rows,
      secondAttention: secondAttention.value.rows,
      treeRoot: tree.value.nodes[0],
    };
  });
  return Effect.runPromise(Effect.scoped(Effect.provide(program, app)));
};

const queryPublicAttention = async (databaseFile: string) => {
  const app = buildSingleWorkspaceLayer({
    databaseFile,
    projectId: firstFixture.projectId,
  });
  const program = Effect.gen(function* () {
    const queries = yield* ProjectionQueryPort;
    const result = yield* queries.query<AttentionReq, AttentionRes>(
      "attention",
      { projectId: firstFixture.projectId },
    );
    return { rows: result.value.rows };
  });
  return Effect.runPromise(Effect.scoped(Effect.provide(program, app)));
};

describe("AH10/P10 Attention materialization", () => {
  it.each([
    {
      field: "aggregate_ref",
      value: "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
    },
    {
      field: "correlation_ref",
      value: "act_018f2b3c-4d5e-7abc-8def-0123456789ff",
    },
    {
      field: "caused_by_command_id",
      value: "cmd_018f2b3c-4d5e-7abc-8def-0123456789ff",
    },
    {
      field: "caused_by_event_id",
      value: "evt_018f2b3c-4d5e-7abc-8def-0123456789ff",
    },
    { field: "actor", value: "user:forged" },
    { field: "occurred_at", value: "2026-10-10T00:00:00.000Z-mismatch" },
  ])(
    "fails closed when P9 event envelope field $field conflicts with its fact",
    async ({ field, value }) => {
      const program = Effect.gen(function* () {
        yield* runMigrations(P37_MIGRATIONS);
        yield* seedSourceOwner(firstFixture);
        const fact = yield* seedP9FailureFactAndEvent(firstFixture);
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          `UPDATE domain_events SET ${field} = ? WHERE event_id = ?`,
          [value, fact.eventId],
        );
        const failed = yield* Effect.exit(runP10AttentionPoll());
        const queryFailure = yield* Effect.exit(
          readMaterializedAttentionView(),
        );
        const tx = yield* TransactionPort;
        const journal = yield* DomainEventJournal;
        const attentionRows = yield* AttentionProjectionStore;
        const sourceFacts = yield* RecoveryAttentionFactStore;
        const events = yield* tx.transact(journal.readAfter(projectId, 0, 10));
        const directApplyFailed = yield* Effect.exit(
          tx.transact(
            makeProjectAttentionProjectionStore(
              projectId,
              sourceFacts,
              attentionRows,
            ).apply(events),
          ),
        );
        return {
          failed,
          queryFailure,
          directApplyFailed,
          offset: yield* readOffset(),
          rows: yield* readAttentionRows(),
        };
      });

      const result = await Effect.runPromise(
        Effect.provide(program, makeApp()),
      );
      expect(Exit.isFailure(result.failed)).toBe(true);
      expect(Exit.isFailure(result.queryFailure)).toBe(true);
      if (Exit.isFailure(result.queryFailure)) {
        expect(Cause.squash(result.queryFailure.cause)).toMatchObject({
          _tag: "ProjectionIntegrityFailure",
          reasonCode: "SourceFactEventMismatch",
          executionId,
        });
      }
      expect(Exit.isFailure(result.directApplyFailed)).toBe(true);
      expect(result.offset).toBe(0);
      expect(result.rows).toEqual([]);
    },
  );

  it("quarantines an unsupported event version while typed P10 reads fail closed", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P37_MIGRATIONS);
      yield* seedSourceOwner(firstFixture);
      const fact = yield* seedP9FailureFactAndEvent(firstFixture);
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "UPDATE domain_events SET event_version = 2 WHERE event_id = ?",
        [fact.eventId],
      );

      const poll = yield* runP10AttentionPoll();
      const tx = yield* TransactionPort;
      const journal = yield* DomainEventJournal;
      const typedJournalRead = yield* Effect.exit(
        tx.transact(journal.readAfter(projectId, 0, 10)),
      );
      const publicAttentionRead = yield* Effect.exit(
        readMaterializedAttentionView(),
      );
      const deadLetters = yield* sql.unsafe<{ readonly reason: string }>(
        `SELECT reason FROM consumer_dead_letters
         WHERE consumer_id = ? AND project_id = ? AND sequence = 1`,
        [consumerId, projectId],
      );
      return {
        poll,
        typedJournalRead,
        publicAttentionRead,
        deadLetterReason: deadLetters[0]?.reason,
        offset: yield* readOffset(),
        rows: yield* readAttentionRows(),
      };
    });

    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(result.poll).toMatchObject({
      fromSequence: 0,
      lastSequence: 1,
      applied: 0,
      quarantined: 1,
    });
    expect(result.deadLetterReason).toBe("unsupported eventVersion 2");
    expect(result.offset).toBe(1);
    expect(result.rows).toEqual([]);
    expect(Exit.isFailure(result.typedJournalRead)).toBe(true);
    if (Exit.isFailure(result.typedJournalRead)) {
      expect(Cause.squash(result.typedJournalRead.cause)).toMatchObject({
        _tag: "PersistenceCorruption",
        repository: "DomainEventJournal",
        operation: "read-event-version-pair",
      });
    }
    expect(Exit.isFailure(result.publicAttentionRead)).toBe(true);
    if (Exit.isFailure(result.publicAttentionRead)) {
      expect(Cause.squash(result.publicAttentionRead.cause)).toMatchObject({
        _tag: "ProjectionReadFailure",
        cause: {
          _tag: "PersistenceCorruption",
          repository: "DomainEventJournal",
          operation: "read-event-version-pair",
        },
      });
    }
  });

  it("rolls back the row and offset together when the projection apply aborts", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P37_MIGRATIONS);
      yield* seedSourceOwner(firstFixture);
      yield* seedP9FailureFactAndEvent(firstFixture);
      const tx = yield* TransactionPort;
      const journal = yield* DomainEventJournal;
      const offsets = yield* ConsumerOffsetStore;
      const deadLetters = yield* ConsumerDeadLetterStore;
      const attentionRows = yield* AttentionProjectionStore;
      const sourceFacts = yield* RecoveryAttentionFactStore;
      const p10Projection = makeProjectAttentionProjectionStore(
        projectId,
        sourceFacts,
        attentionRows,
      );
      const abortedProjection = {
        apply: (batch: Parameters<typeof p10Projection.apply>[0]) =>
          p10Projection.apply(batch).pipe(
            Effect.andThen(
              Effect.fail({
                _tag: "PersistenceCorruption" as const,
                repository: "ConsumerOffsetStore" as const,
                operation: "injected-abort",
                reason: "test abort after Attention row write",
              }),
            ),
          ),
        reset: p10Projection.reset,
      };
      const failed = yield* Effect.exit(
        pollOnce(consumerId, projectId, 10, {
          tx,
          journal,
          offsets,
          deadLetters,
          projection: abortedProjection,
          handlers: () => Effect.succeed([]),
        }),
      );
      const offsetAfterAbort = yield* readOffset();
      const rowsAfterAbort = yield* readAttentionRows();
      const sql = yield* SqlClient;
      const p1Markers = yield* sql.unsafe(
        "SELECT sequence FROM projection_state WHERE project_id = ?",
        [projectId],
      );
      yield* runP10AttentionPoll();
      return {
        failed,
        offsetAfterAbort,
        rowsAfterAbort,
        p1Markers,
        offsetAfterRetry: yield* readOffset(),
        rowsAfterRetry: yield* readAttentionRows(),
      };
    });

    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(Exit.isFailure(result.failed)).toBe(true);
    expect(result.offsetAfterAbort).toBe(0);
    expect(result.rowsAfterAbort).toEqual([]);
    expect(result.p1Markers).toEqual([]);
    expect(result.offsetAfterRetry).toBe(1);
    expect(result.rowsAfterRetry).toHaveLength(1);
  });

  it("projects the real P9 fact/event once with its consumer offset", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P37_MIGRATIONS);
      yield* seedSourceOwner(firstFixture);
      const fact = yield* seedP9FailureFactAndEvent(firstFixture);
      const consumed = yield* runP10AttentionPoll();
      const tx = yield* TransactionPort;
      const offsets = yield* ConsumerOffsetStore;
      yield* tx.transact(offsets.advance(consumerId, projectId, 0));
      const replayed = yield* runP10AttentionPoll();
      return {
        fact,
        consumed,
        replayed,
        offset: yield* readOffset(),
        rows: yield* readAttentionRows(),
        viewRows: yield* readMaterializedAttentionView(),
      };
    });

    const { fact, consumed, replayed, offset, rows, viewRows } =
      await Effect.runPromise(Effect.provide(program, makeApp()));

    expect(consumed.lastSequence).toBe(1);
    expect(replayed.applied).toBe(1);
    expect(offset).toBe(1);
    expect(rows).toEqual([
      {
        projectId,
        dedupKey: fact.attentionFactId,
        source: "AssignWorkTargetBindingFailure",
        severity: "ActionRequired",
        targetWorkspaceId: parentWorkspaceId,
        summary:
          "A committed AssignWork could not be proven to match its exact target; recovery is paused.",
        failureCode: "MissingBinding",
        occurredAt: "2026-10-10T00:00:00.000Z",
        sourceEventId: fact.eventId,
        sourceFactId: fact.attentionFactId,
        sourceExecutionId: executionId,
      },
    ]);
    expect(viewRows).toEqual([
      {
        source: "AssignWorkTargetBindingFailure",
        severity: "ActionRequired",
        targetWorkspaceId: parentWorkspaceId,
        dedupKey: fact.attentionFactId,
        summary:
          "A committed AssignWork could not be proven to match its exact target; recovery is paused.",
        occurredAt: "2026-10-10T00:00:00.000Z",
      },
    ]);
    expect(Object.keys(viewRows[0] ?? {})).not.toContain("failureCode");
    expect(
      subtreeAttentionAggregate(viewRows, () => null).get(parentWorkspaceId),
    ).toEqual({ attention: 0, actionRequired: 1 });
  });

  it("makes Deliver replay failure ActionRequired and rebuilds from the retained P9 fact after event pruning", async () => {
    const directory = createFunctionalFixtureDirectory();
    const databaseFile = join(directory, "arbor.sqlite");
    try {
      const seedProgram = Effect.gen(function* () {
        yield* runMigrations(P37_MIGRATIONS);
        yield* seedSourceOwner(firstFixture);
        return yield* seedP9DeliverReplayFailure();
      });
      const fact = await Effect.runPromise(
        Effect.provide(seedProgram, makeApp(databaseFile)),
      );
      await upgradeHistoricalAttentionFixtureToSchema51(
        databaseFile,
        directory,
      );

      const program = Effect.gen(function* () {
        const poll = yield* runP37AttentionPoll();
        const firstRows = yield* readDeliverAttentionRows();
        const firstView = yield* readMaterializedAttentionView();
        const pending = yield* Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const facts = yield* RecoveryAttentionFactStore;
          return yield* tx.transact(
            facts.listPendingDeliverReplayAttention(projectId, 64),
          );
        });
        const sql = yield* SqlClient;
        const blockedHandoverRows = {
          messages: yield* sql.unsafe<{ readonly count: number }>(
            "SELECT COUNT(*) AS count FROM messages WHERE sender_workspace_id = ? OR recipient_workspace_id = ?",
            [parentWorkspaceId, parentWorkspaceId],
          ),
          inbox: yield* sql.unsafe<{ readonly count: number }>(
            "SELECT COUNT(*) AS count FROM inbox_entries WHERE workspace_id = ?",
            [parentWorkspaceId],
          ),
          messageSent: yield* sql.unsafe<{ readonly count: number }>(
            "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'MessageSent' AND project_id = ?",
            [projectId],
          ),
        };
        return {
          fact,
          poll,
          firstRows,
          firstView,
          pending,
          blockedHandoverRows,
        };
      });

      const result = await Effect.runPromise(
        Effect.provide(program, makeApp(databaseFile)),
      );
      const publicBeforePrune = await queryPublicAttentionAndTree(databaseFile);
      const rebuildAfterPrune = Effect.gen(function* () {
        const sql = yield* SqlClient;
        // Simulate P1 journal pruning while preserving the P9 fact source.
        yield* sql.unsafe("DELETE FROM domain_events WHERE event_id = ?", [
          result.fact.eventId,
        ]);
        yield* sql.unsafe(
          "DELETE FROM deliver_replay_attention_rows WHERE attention_fact_id = ?",
          [result.fact.attentionFactId],
        );
        yield* rebuildP10Attention();
        return {
          rows: yield* readDeliverAttentionRows(),
          view: yield* readMaterializedAttentionView(),
        };
      });
      const rebuilt = await Effect.runPromise(
        Effect.provide(rebuildAfterPrune, makeApp(databaseFile)),
      );
      const publicAfterPrune = await queryPublicAttentionAndTree(databaseFile);
      const expectedAttention = {
        source: "DeliverReplayFailure",
        severity: "ActionRequired",
        targetWorkspaceId: parentWorkspaceId,
        dedupKey: result.fact.attentionFactId,
        summary:
          "A Deliver handover could not be reconciled with its exact Message and MessageSent facts; execution recovery is paused.",
        occurredAt: "2026-10-10T00:00:00.000Z",
        failureCode: "LegacyMessageMissingEvent",
      };
      const expectedPublicAttention = {
        source: "DeliverReplayFailure",
        severity: "ActionRequired",
        targetWorkspaceId: parentWorkspaceId,
        dedupKey: result.fact.attentionFactId,
        summaryRef:
          "A Deliver handover could not be reconciled with its exact Message and MessageSent facts; execution recovery is paused.",
        occurredAt: "2026-10-10T00:00:00.000Z",
        failureCode: "LegacyMessageMissingEvent",
      };

      expect(result.poll.lastSequence).toBe(1);
      expect(result.firstRows).toHaveLength(1);
      expect(result.pending).toEqual([]);
      expect(result.firstView).toEqual([expectedAttention]);
      expect(result.blockedHandoverRows).toEqual({
        messages: [{ count: 0 }],
        inbox: [{ count: 0 }],
        messageSent: [{ count: 0 }],
      });
      expect(result.firstView).toEqual([expectedAttention]);
      expect(publicBeforePrune.firstAttention).toEqual([
        expect.objectContaining({
          source: "DeliverReplayFailure",
          dedupKey: result.fact.attentionFactId,
        }),
      ]);
      expect(publicBeforePrune.treeRoot?.subtreeAttention).toEqual({
        attention: 0,
        actionRequired: 1,
      });
      expect(rebuilt.rows).toHaveLength(1);
      expect(rebuilt.rows[0]?.dedupKey).toBe(result.fact.attentionFactId);
      expect(rebuilt.view).toEqual([expectedAttention]);
      expect(publicAfterPrune.firstAttention).toEqual([
        expectedPublicAttention,
      ]);
      expect(publicAfterPrune.treeRoot?.subtreeAttention).toEqual({
        attention: 0,
        actionRequired: 1,
      });
      expect(JSON.stringify(rebuilt.view)).not.toContain(result.fact.messageId);
      expect(JSON.stringify(rebuilt.view)).not.toContain(result.fact.eventId);
    } finally {
      removeFunctionalFixtureDirectory(directory);
    }
  });

  it("keeps stale materialized sources out across WorkSteered lag, rebuild, and SQLite reopen", async () => {
    const directory = createFunctionalFixtureDirectory();
    const databaseFile = join(directory, "arbor.sqlite");
    try {
      const seedProgram = Effect.gen(function* () {
        yield* runMigrations(P37_MIGRATIONS);
        yield* seedSourceOwner(firstFixture);
        yield* seedP9FailureFactAndEvent(firstFixture);
        yield* seedP9DeliverReplayFailure();
      });
      await Effect.runPromise(
        Effect.provide(seedProgram, makeApp(databaseFile)),
      );
      await upgradeHistoricalAttentionFixtureToSchema51(
        databaseFile,
        directory,
      );

      const program = Effect.gen(function* () {
        yield* runP37AttentionPoll();
        const before = yield* readMaterializedAttentionView();
        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        const journal = yield* DomainEventJournal;
        yield* sql.unsafe("UPDATE works SET revision = 1 WHERE work_id = ?", [
          workId,
        ]);
        const afterSteerBeforeCatchup = yield* readMaterializedAttentionView();
        yield* tx.transact(
          journal.append([
            {
              projectId,
              eventType: "WorkSteered",
              eventVersion: 1,
              occurredAt: "2026-10-11T00:00:00.000Z",
              aggregateRef: workId,
              actor: "user:test" as never,
              payload: {
                _tag: "WorkSteered",
                workId,
                fromRevision: 0,
                toRevision: 1,
                severity: "Normal",
              },
            },
          ]),
        );
        yield* runP37AttentionPoll();
        const rowsAfterCatchup = yield* readAttentionRows();
        const deliverRowsAfterCatchup = yield* readDeliverAttentionRows();
        const retainedSources = yield* sql.unsafe<{
          readonly assign_count: number;
          readonly deliver_count: number;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM assign_work_binding_attention_facts WHERE project_id = ?) AS assign_count,
             (SELECT COUNT(*) FROM deliver_replay_attention_facts WHERE project_id = ?) AS deliver_count`,
          [projectId, projectId],
        );
        yield* rebuildP10Attention();
        return {
          before,
          afterSteerBeforeCatchup,
          rowsAfterCatchup,
          deliverRowsAfterCatchup,
          retainedSources: retainedSources[0],
          rowsAfterRebuild: yield* readAttentionRows(),
          deliverRowsAfterRebuild: yield* readDeliverAttentionRows(),
        };
      });
      const result = await Effect.runPromise(
        Effect.provide(program, makeApp(databaseFile)),
      );
      expect(result.before.map((row) => row.source)).toEqual([
        "AssignWorkTargetBindingFailure",
        "DeliverReplayFailure",
      ]);
      expect(result.afterSteerBeforeCatchup).toEqual([]);
      expect(result.rowsAfterCatchup).toEqual([]);
      expect(result.deliverRowsAfterCatchup).toEqual([]);
      expect(result.retainedSources).toEqual({
        assign_count: 1,
        deliver_count: 1,
      });
      expect(result.rowsAfterRebuild).toEqual([]);
      expect(result.deliverRowsAfterRebuild).toEqual([]);

      const afterReopen = await queryPublicAttention(databaseFile);
      expect(afterReopen.rows).toEqual([]);
    } finally {
      removeFunctionalFixtureDirectory(directory);
    }
  });

  it("rebuilds the fact-backed row without clearing another project's rows", async () => {
    const directory = createFunctionalFixtureDirectory();
    const databaseFile = join(directory, "arbor.sqlite");
    try {
      const seedProgram = Effect.gen(function* () {
        yield* runMigrations(P37_MIGRATIONS);
        yield* seedSourceOwner(firstFixture);
        yield* seedSourceOwner(secondFixture);
        yield* seedP9FailureFactAndEvent(firstFixture);
        yield* seedP9FailureFactAndEvent(secondFixture);
      });
      await Effect.runPromise(
        Effect.provide(seedProgram, makeApp(databaseFile)),
      );
      await upgradeHistoricalAttentionFixtureToSchema51(
        databaseFile,
        directory,
      );

      const program = Effect.gen(function* () {
        yield* runP10AttentionPoll(firstFixture.projectId);
        yield* runP10AttentionPoll(secondFixture.projectId);
        const incremental = yield* readAttentionRows();
        const otherProjectBeforeRebuild = yield* readAttentionRows(
          secondFixture.projectId,
        );
        const tx = yield* TransactionPort;
        const journal = yield* DomainEventJournal;
        const genericProjection = yield* ProjectionStore;
        const secondProjectEvents = yield* tx.transact(
          journal.readAfter(secondFixture.projectId, 0, 10),
        );
        yield* tx.transact(genericProjection.apply(secondProjectEvents));
        yield* rebuildP10Attention(firstFixture.projectId);
        const sql = yield* SqlClient;
        return {
          offset: yield* readOffset(firstFixture.projectId),
          otherProjectOffset: yield* readOffset(secondFixture.projectId),
          incremental,
          rebuilt: yield* readAttentionRows(),
          otherProjectBeforeRebuild,
          otherProjectAfterRebuild: yield* readAttentionRows(
            secondFixture.projectId,
          ),
          otherProjectP1Markers: yield* sql.unsafe(
            "SELECT sequence FROM projection_state WHERE project_id = ? ORDER BY sequence",
            [secondFixture.projectId],
          ),
        };
      });

      const {
        offset,
        otherProjectOffset,
        incremental,
        rebuilt,
        otherProjectBeforeRebuild,
        otherProjectAfterRebuild,
        otherProjectP1Markers,
      } = await Effect.runPromise(
        Effect.provide(program, makeApp(databaseFile)),
      );
      expect(offset).toBe(1);
      expect(otherProjectOffset).toBe(1);
      expect(rebuilt).toEqual(incremental);
      expect(rebuilt).toHaveLength(1);
      expect(otherProjectAfterRebuild).toEqual(otherProjectBeforeRebuild);
      expect(otherProjectAfterRebuild).toHaveLength(1);
      expect(otherProjectP1Markers).toHaveLength(1);
    } finally {
      removeFunctionalFixtureDirectory(directory);
    }
  });

  it("retains the exact projected row and offset after a database close/reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-p10-attention-"));
    const filename = join(directory, "attention.sqlite");
    try {
      const firstProcess = Effect.gen(function* () {
        yield* runMigrations(P37_MIGRATIONS);
        yield* seedSourceOwner(firstFixture);
        yield* seedP9FailureFactAndEvent(firstFixture);
        yield* runP10AttentionPoll();
      });
      await Effect.runPromise(
        Effect.scoped(Effect.provide(firstProcess, makeApp(filename))),
      );

      const reopened = Effect.gen(function* () {
        return {
          offset: yield* readOffset(),
          rows: yield* readAttentionRows(),
        };
      });
      const state = await Effect.runPromise(
        Effect.scoped(Effect.provide(reopened, makeApp(filename))),
      );
      expect(state.offset).toBe(1);
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0]?.dedupKey).toMatch(/^att_[0-9a-f]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("real daemon discovers projects, survives pre/post-commit kills, and rebuilds to the same public Attention/Tree view", async () => {
    const directory = createFunctionalFixtureDirectory();
    const databaseFile = join(directory, "daemon.sqlite");
    let runningChild: ReturnType<typeof spawn> | undefined;
    try {
      const seed = Effect.gen(function* () {
        yield* runMigrations(P37_MIGRATIONS);
        yield* seedSourceOwner(firstFixture);
        yield* seedSourceOwner(secondFixture);
        const firstFact = yield* seedP9FailureFactAndEvent(firstFixture);
        const secondFact = yield* seedP9FailureFactAndEvent(secondFixture);
        return { firstFact, secondFact };
      });
      const seeded = await Effect.runPromise(
        Effect.scoped(Effect.provide(seed, makeApp(databaseFile))),
      );
      await upgradeHistoricalAttentionFixtureToSchema51(
        databaseFile,
        directory,
      );

      const prime = Effect.gen(function* () {
        // Prime only Project B through P10, and put a P1 marker there. The
        // real daemon must later discover B's second pending event from the
        // Open-project scan while configured only for Project A.
        yield* runP10AttentionPoll(secondFixture.projectId);
        const secondPendingFact = yield* seedP9FailureFactAndEvent(
          secondFixture,
          `${secondFixture.logicalActionId}:pending`,
        );
        const tx = yield* TransactionPort;
        const journal = yield* DomainEventJournal;
        const p1Projection = yield* ProjectionStore;
        const secondEvents = yield* tx.transact(
          journal.readAfter(secondFixture.projectId, 0, 1),
        );
        yield* tx.transact(p1Projection.apply(secondEvents));
        return { ...seeded, secondPendingFact };
      });
      const facts = await Effect.runPromise(
        Effect.scoped(Effect.provide(prime, makeApp(databaseFile))),
      );

      const beforeCommitMarker = join(directory, "before-commit.marker");
      const beforeCommit = await startDaemonChildUntilMarker(
        databaseFile,
        String(firstFixture.projectId),
        "hold-before-commit",
        beforeCommitMarker,
      );
      runningChild = beforeCommit.child;
      expect(beforeCommit.marker).toBe(facts.firstFact.attentionFactId);
      await killDaemonChild(runningChild);
      runningChild = undefined;

      const afterPreCommitKill = await inspectFileProjectionState(databaseFile);
      expect(afterPreCommitKill.firstOffset).toBe(0);
      expect(afterPreCommitKill.firstRows).toEqual([]);
      expect(afterPreCommitKill.secondOffset).toBe(1);
      expect(afterPreCommitKill.secondRows).toHaveLength(1);
      expect(afterPreCommitKill.secondProjectP1Markers).toHaveLength(1);

      const afterCommitMarker = join(directory, "after-commit.marker");
      const afterCommit = await startDaemonChildUntilMarker(
        databaseFile,
        String(firstFixture.projectId),
        "hold-after-poll",
        afterCommitMarker,
      );
      runningChild = afterCommit.child;
      expect(afterCommit.marker).toBe("poll-committed");
      await killDaemonChild(runningChild);
      runningChild = undefined;

      const afterPostCommitKill =
        await inspectFileProjectionState(databaseFile);
      expect(afterPostCommitKill.firstOffset).toBe(1);
      expect(afterPostCommitKill.firstRows).toHaveLength(1);
      expect(afterPostCommitKill.firstRows[0]?.dedupKey).toBe(
        facts.firstFact.attentionFactId,
      );
      expect(afterPostCommitKill.secondOffset).toBe(2);
      expect(afterPostCommitKill.secondRows.map((row) => row.dedupKey)).toEqual(
        expect.arrayContaining([
          facts.secondFact.attentionFactId,
          facts.secondPendingFact.attentionFactId,
        ]),
      );
      expect(afterPostCommitKill.secondRows).toHaveLength(2);
      expect(afterPostCommitKill.secondProjectP1Markers).toHaveLength(2);

      const restartMarker = join(directory, "restart.marker");
      const restart = await startDaemonChildUntilMarker(
        databaseFile,
        String(firstFixture.projectId),
        "hold-after-poll",
        restartMarker,
      );
      runningChild = restart.child;
      expect(restart.marker).toBe("poll-committed");
      await killDaemonChild(runningChild);
      runningChild = undefined;

      const afterRestart = await inspectFileProjectionState(databaseFile);
      expect(afterRestart.firstOffset).toBe(1);
      expect(afterRestart.firstRows).toHaveLength(1);
      expect(afterRestart.secondOffset).toBe(2);
      expect(afterRestart.secondRows).toHaveLength(2);
      expect(afterRestart.secondProjectP1Markers).toHaveLength(2);
      const beforeRebuildView = await queryPublicAttentionAndTree(databaseFile);

      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            rebuildP10Attention(firstFixture.projectId),
            makeApp(databaseFile),
          ),
        ),
      );

      const afterRebuild = await inspectFileProjectionState(databaseFile);
      const afterRebuildView = await queryPublicAttentionAndTree(databaseFile);
      expect(afterRebuild.firstOffset).toBe(1);
      expect(afterRebuild.firstRows).toHaveLength(1);
      expect(afterRebuild.secondOffset).toBe(2);
      expect(afterRebuild.secondRows).toHaveLength(2);
      expect(afterRebuild.secondProjectP1Markers).toEqual(
        afterRestart.secondProjectP1Markers,
      );
      expect(afterRebuildView).toEqual(beforeRebuildView);
      expect(afterRebuildView.firstAttention).toHaveLength(1);
      expect(afterRebuildView.firstAttention[0]?.dedupKey).toBe(
        facts.firstFact.attentionFactId,
      );
      expect(afterRebuildView.secondAttention).toHaveLength(2);
      expect(afterRebuildView.treeRoot?.subtreeAttention).toEqual({
        attention: 0,
        actionRequired: 1,
      });
    } finally {
      if (runningChild !== undefined) await killDaemonChild(runningChild);
      removeFunctionalFixtureDirectory(directory);
    }
  });
});
