import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  invocationAuthoritySourceRevisionOf,
  type ToolInvocationIntent,
  ToolInvocationStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  layer,
  P36_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workerId = "worker:ah7-store-concurrency";
const workerIncarnationId = "incarnation:ah7-store-concurrency";
const executionFence = {
  executionId,
  workerId,
  workerIncarnationId,
  fencingGeneration: parse(LeaseGeneration)(0),
};
const now = "2026-10-12T00:00:01.000Z";
const invocationIntent: ToolInvocationIntent = {
  invocationId,
  executionId,
  workspaceId,
  toolName: "write_once",
  toolVersion: "1",
  sideEffectSemantics: "NonIdempotent",
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId: null,
  intentAt: now,
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("arbor-ah7-store-")
    ) {
      throw new Error(`Unsafe AH7 test cleanup target: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
});

const makeInfrastructure = (databaseFile: string) => {
  const sqlite = layer({ filename: databaseFile });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
  );
};

const seedDatabase = Effect.gen(function* () {
  yield* runMigrations(P36_MIGRATIONS);
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'AH7 Store concurrency', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
        [projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [sessionId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
        [workspaceId, projectId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
          'fixture', ?, 't0', NULL, NULL, NULL, NULL)`,
        [executionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO execution_leases (
          execution_id, worker_id, worker_incarnation_id, generation,
          expires_at, updated_at
        ) VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', 't0')`,
        [executionId, workerId, workerIncarnationId],
      );
    }),
  );
});

const runStore = <A, E>(
  app: ReturnType<typeof makeInfrastructure>,
  body: Effect.Effect<A, E, TransactionPort | ToolInvocationStore | SqlClient>,
) => Effect.runPromise(Effect.scoped(Effect.provide(body, app)));

describe("AH7 SQLite Store concurrency", () => {
  it("converges exact same-invocation intent claims across independent connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-ah7-store-"));
    directories.push(directory);
    const databaseFile = join(directory, "shared.db");
    const connectionA = makeInfrastructure(databaseFile);
    const connectionB = makeInfrastructure(databaseFile);

    await Effect.runPromise(
      Effect.scoped(Effect.provide(seedDatabase, connectionA)),
    );
    const insert = (app: typeof connectionA) =>
      runStore(
        app,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ToolInvocationStore;
          return yield* tx.transact(
            store.recordIntent(invocationIntent, executionFence, now),
          );
        }),
      );
    const competing = await Promise.all([
      insert(connectionA),
      insert(connectionB),
    ]);
    const persisted = await runStore(
      connectionA,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
          [invocationId],
        );
        const columns = yield* sql.unsafe<{ name: string; pk: number }>(
          "PRAGMA table_info(tool_invocations)",
        );
        return { rows, columns };
      }),
    );

    expect(competing).toEqual(["Recorded", "Recorded"]);
    expect(
      persisted.columns.find((column) => column.name === "invocation_id")?.pk,
    ).toBe(1);
    expect(Number(persisted.rows[0]?.count ?? 0)).toBe(1);
  });

  it("records one real NotAdmitted to MayHaveStarted Store transition across connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-ah7-store-"));
    directories.push(directory);
    const databaseFile = join(directory, "shared.db");
    const connectionA = makeInfrastructure(databaseFile);
    const connectionB = makeInfrastructure(databaseFile);

    await Effect.runPromise(
      Effect.scoped(Effect.provide(seedDatabase, connectionA)),
    );
    await runStore(
      connectionA,
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ToolInvocationStore;
        const sql = yield* SqlClient;
        yield* tx.transact(
          store.recordIntent(invocationIntent, executionFence, now),
        );
        yield* sql.unsafe(
          `CREATE TABLE ah7_effect_admission_audit (
             transition_id INTEGER PRIMARY KEY
           )`,
        );
        yield* sql.unsafe(
          `CREATE TRIGGER ah7_effect_admission_audit_trigger
           AFTER UPDATE OF effect_admission_state ON tool_invocations
           WHEN OLD.invocation_id = '${invocationId}'
             AND OLD.effect_admission_state = 'NotAdmitted'
             AND NEW.effect_admission_state = 'MayHaveStarted'
           BEGIN
             INSERT INTO ah7_effect_admission_audit (transition_id) VALUES (NULL);
           END`,
        );
      }),
    );

    const authority = {
      principal: parse(Principal)(workerId),
      workspaceId,
      executionId,
      toolName: invocationIntent.toolName,
      toolVersion: invocationIntent.toolVersion,
      resourceSpaceIds: [],
      allowedCapabilities: [],
      controlBasisDigest: "ah7-store-basis",
      expiresAt: "2999-01-01T00:00:00.000Z",
      delegationDepth: 0,
      sourceRevision: invocationAuthoritySourceRevisionOf({
        workspacePolicyRevision: 0,
        activeGrants: [],
        verifierId: null,
      }),
    };
    const admit = (app: typeof connectionA) =>
      runStore(
        app,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ToolInvocationStore;
          return yield* tx.transact(
            store.admitEffect(invocationId, authority, now, executionFence),
          );
        }),
      );
    const admissions = await Promise.all([
      admit(connectionA),
      admit(connectionB),
    ]);
    const persisted = await runStore(
      connectionA,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{
          count: number;
          effect_admission_state: string;
          settled_at: string | null;
          settlement_kind: string | null;
        }>(
          `SELECT COUNT(*) AS count,
                  MIN(effect_admission_state) AS effect_admission_state,
                  MIN(settled_at) AS settled_at,
                  MIN(settlement_kind) AS settlement_kind
             FROM tool_invocations WHERE invocation_id = ?`,
          [invocationId],
        );
        const transitions = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM ah7_effect_admission_audit",
        );
        return { row: rows[0], transitions: transitions[0]?.count };
      }),
    );

    // Both store calls may report Admitted: a serialized second call reads the
    // already-admitted row. The audit trigger proves one persisted transition,
    // not one ToolRuntime caller or Executor effect.
    expect(admissions).toEqual([{ _tag: "Admitted" }, { _tag: "Admitted" }]);
    expect(persisted).toEqual({
      row: {
        count: 1,
        effect_admission_state: "MayHaveStarted",
        settled_at: null,
        settlement_kind: null,
      },
      transitions: 1,
    });
  });

  it("returns typed corruption when a controlled SQLite adapter makes admission apply no row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-ah7-store-"));
    directories.push(directory);
    const databaseFile = join(directory, "shared.db");
    const app = makeInfrastructure(databaseFile);
    await Effect.runPromise(Effect.scoped(Effect.provide(seedDatabase, app)));

    const authority = {
      principal: parse(Principal)(workerId),
      workspaceId,
      executionId,
      toolName: invocationIntent.toolName,
      toolVersion: invocationIntent.toolVersion,
      resourceSpaceIds: [],
      allowedCapabilities: [],
      controlBasisDigest: "ah7-store-basis",
      expiresAt: "2999-01-01T00:00:00.000Z",
      delegationDepth: 0,
      sourceRevision: invocationAuthoritySourceRevisionOf({
        workspacePolicyRevision: 0,
        activeGrants: [],
        verifierId: null,
      }),
    };
    const result = await runStore(
      app,
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ToolInvocationStore;
        const sql = yield* SqlClient;
        yield* tx.transact(
          store.recordIntent(invocationIntent, executionFence, now),
        );
        // This deterministic test-only trigger models an adapter CAS which
        // applies no row; it does not claim this occurs in a real DB race.
        yield* sql.unsafe(
          `CREATE TRIGGER ah7_suppress_effect_admission
           BEFORE UPDATE OF effect_admission_state ON tool_invocations
           WHEN OLD.invocation_id = '${invocationId}'
             AND OLD.effect_admission_state = 'NotAdmitted'
             AND NEW.effect_admission_state = 'MayHaveStarted'
           BEGIN
             SELECT RAISE(IGNORE);
           END`,
        );
        const outcome = yield* Effect.match(
          tx.transact(
            store.admitEffect(invocationId, authority, now, executionFence),
          ),
          {
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (value) => ({ _tag: "Success" as const, value }),
          },
        );
        const rows = yield* sql.unsafe<{
          effect_admission_state: string;
          settled_at: string | null;
        }>(
          "SELECT effect_admission_state, settled_at FROM tool_invocations WHERE invocation_id = ?",
          [invocationId],
        );
        return { outcome, row: rows[0] };
      }),
    );

    expect(result.outcome).toMatchObject({
      _tag: "Failure",
      error: {
        _tag: "PersistenceCorruption",
        repository: "ToolInvocationStore",
        operation: "admit-effect",
        reason: "effect-admission compare-and-set did not apply",
      },
    });
    expect(result.row).toEqual({
      effect_admission_state: "NotAdmitted",
      settled_at: null,
    });
  });
});
