import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AttentionProjectionStoreLive,
  ClockLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeProjectAttentionProjectionStore,
  makeRecoveryAttentionFactStoreLive,
  P10_ATTENTION_CONSUMER_ID,
  P34_MIGRATIONS,
  ProjectionStoreLive,
  rebuildProjection,
  runMigrations,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import { buildSingleWorkspaceLayer } from "../../../apps/single-workspace/src/index.js";
import type {
  AttentionReq,
  AttentionRes,
  TreeViewReq,
  TreeViewRes,
} from "../../../packages/api-contracts/src/views.js";
import { pollOnce } from "../../../packages/application/src/consumer-loop.js";
import {
  CommandId,
  ExecutionId,
  ProjectId,
  parse,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import {
  AttentionProjectionStore,
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

const readMaterializedAttentionView = (targetProjectId = projectId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const attention = yield* AttentionProjectionStore;
    const deps: AttentionReadDeps = {
      listWorkspacesByProject: () => Effect.succeed([]),
      listWorksByWorkspace: () => Effect.succeed([]),
      listExecutionSettlementFacts: () => Effect.succeed([]),
      listOpenVerifications: () => Effect.succeed([]),
      listUnsatisfiedDependencies: () => Effect.succeed([]),
      findDependency: () => Effect.succeed(Option.none()),
      readEvents: () => Effect.succeed([]),
      listProjectedAssignWorkBindingFailures: (projectIdValue) =>
        tx
          .transact(attention.listAssignWorkBindingFailures(projectIdValue))
          .pipe(Effect.mapError(projectionReadError)),
    };
    return yield* deriveProjectAttention(targetProjectId, deps);
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
    { cwd: repositoryRoot, stdio: "ignore" },
  );
  const startedAt = Date.now();
  while (!existsSync(markerFile)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `daemon child exited before marker (${String(child.exitCode)}/${String(child.signalCode)})`,
      );
    }
    if (Date.now() - startedAt > 60_000) {
      child.kill("SIGKILL");
      throw new Error(`timed out waiting for daemon marker ${markerFile}`);
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
    { field: "occurred_at", value: "2026-10-10T00:00:00.000Z-mismatch" },
  ])(
    "fails closed when P9 event envelope field $field conflicts with its fact",
    async ({ field, value }) => {
      const program = Effect.gen(function* () {
        yield* runMigrations(P34_MIGRATIONS);
        yield* seedSourceOwner(firstFixture);
        const fact = yield* seedP9FailureFactAndEvent(firstFixture);
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          `UPDATE domain_events SET ${field} = ? WHERE event_id = ?`,
          [value, fact.eventId],
        );
        const failed = yield* Effect.exit(runP10AttentionPoll());
        return {
          failed,
          offset: yield* readOffset(),
          rows: yield* readAttentionRows(),
        };
      });

      const result = await Effect.runPromise(
        Effect.provide(program, makeApp()),
      );
      expect(Exit.isFailure(result.failed)).toBe(true);
      expect(result.offset).toBe(0);
      expect(result.rows).toEqual([]);
    },
  );

  it("rolls back the row and offset together when the projection apply aborts", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P34_MIGRATIONS);
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
      yield* runMigrations(P34_MIGRATIONS);
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

  it("rebuilds the fact-backed row without clearing another project's rows", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P34_MIGRATIONS);
      yield* seedSourceOwner(firstFixture);
      yield* seedSourceOwner(secondFixture);
      yield* seedP9FailureFactAndEvent(firstFixture);
      yield* seedP9FailureFactAndEvent(secondFixture);
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
    } = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(offset).toBe(1);
    expect(otherProjectOffset).toBe(1);
    expect(rebuilt).toEqual(incremental);
    expect(rebuilt).toHaveLength(1);
    expect(otherProjectAfterRebuild).toEqual(otherProjectBeforeRebuild);
    expect(otherProjectAfterRebuild).toHaveLength(1);
    expect(otherProjectP1Markers).toHaveLength(1);
  });

  it("retains the exact projected row and offset after a database close/reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-p10-attention-"));
    const filename = join(directory, "attention.sqlite");
    try {
      const firstProcess = Effect.gen(function* () {
        yield* runMigrations(P34_MIGRATIONS);
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
    const directory = mkdtempSync(
      join(tmpdir(), "arbor-p10-attention-daemon-"),
    );
    const databaseFile = join(directory, "daemon.sqlite");
    let runningChild: ReturnType<typeof spawn> | undefined;
    try {
      const seed = Effect.gen(function* () {
        yield* runMigrations(P34_MIGRATIONS);
        yield* seedSourceOwner(firstFixture);
        yield* seedSourceOwner(secondFixture);
        const firstFact = yield* seedP9FailureFactAndEvent(firstFixture);
        const secondFact = yield* seedP9FailureFactAndEvent(secondFixture);
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
        return { firstFact, secondFact, secondPendingFact };
      });
      const facts = await Effect.runPromise(
        Effect.scoped(Effect.provide(seed, makeApp(databaseFile))),
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
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
