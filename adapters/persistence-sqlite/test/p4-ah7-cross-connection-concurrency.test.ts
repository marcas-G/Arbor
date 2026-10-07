import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolInvocationIntent,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
} from "@arbor/ports";
import type * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutor } from "../../../packages/tool-runtime/src/index.js";
import { ToolRuntimeLive } from "../../../packages/tool-runtime/src/index.js";
import {
  layer,
  P4_MIGRATIONS,
  runMigrations,
  type SqliteAdapterError,
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
const principal = parse(Principal)("worker:ah7-cross-connection");
const actor = parse(Actor)("worker:ah7-cross-connection");
const marker = "AH7_NONIDEMPOTENT_CROSS_CONNECTION_EFFECT";

const definition: ToolDefinition = {
  name: "write_once",
  version: "1",
  hash: "write-once-v1",
  description: "Perform a non-idempotent side effect.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "NonIdempotent",
  source: "Builtin",
};

const intent = {
  callRef: "call-ah7-cross-connection",
  toolName: definition.name,
  toolVersion: definition.version,
  argumentsJson: "{}",
  invocationId,
  approvalId: null,
} as const;

const context: ToolExecutionContext = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority: {
    principal,
    workspaceId,
    executionId,
    toolName: intent.toolName,
    toolVersion: intent.toolVersion,
    resourceSpaceIds: [],
    allowedCapabilities: [],
    controlBasisDigest: "ah7-cross-connection-basis",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "ah7-cross-connection-basis",
  requestedAt: "2026-10-07T00:00:00.000Z",
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("arbor-ah7-cross-")
    ) {
      throw new Error(`Unsafe AH7 test cleanup target: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
});

type StoreLayer = Layer.Layer<
  SqlClient | SqliteClient.SqliteClient | TransactionPort | ToolInvocationStore,
  SqliteAdapterError
>;

type RuntimeLayer = Layer.Layer<
  | SqlClient
  | SqliteClient.SqliteClient
  | TransactionPort
  | ToolInvocationStore
  | ToolDefinitionStore
  | ToolRuntimePort
  | SandboxPort
  | ResourceAdmission
  | ProjectEnvironmentPort
  | Clock,
  SqliteAdapterError
>;

const makeInfrastructure = (databaseFile: string): StoreLayer => {
  const sqlite = layer({ filename: databaseFile });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
  );
};

const seedDatabase = Effect.gen(function* () {
  yield* runMigrations(P4_MIGRATIONS);
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "AH7 cross connection",
          workspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          workspaceId,
          projectId,
          "AH7 cross connection workspace",
          "{}",
          0,
          "{}",
          0,
          "{}",
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
        [
          executionId,
          projectId,
          "workspace",
          workspaceId,
          "coordination",
          sessionId,
          "t",
        ],
      );
    }),
  );
});

const invocationIntent: ToolInvocationIntent = {
  invocationId,
  executionId,
  workspaceId,
  toolName: intent.toolName,
  toolVersion: intent.toolVersion,
  sideEffectSemantics: "NonIdempotent",
  argumentsJson: intent.argumentsJson,
  resolvedRegions: [],
  approvalId: null,
  intentAt: "2026-10-07T00:00:01.000Z",
};

const runIntentInsert = (app: StoreLayer) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.match(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const store = yield* ToolInvocationStore;
            return yield* tx.transact(store.recordIntent(invocationIntent));
          }),
          {
            onFailure: (error) => ({ _tag: "Rejected" as const, error }),
            onSuccess: () => ({ _tag: "Inserted" as const }),
          },
        ),
        app,
      ),
    ),
  );

const toolRuntimeDependencies = (
  infrastructure: StoreLayer,
  rendezvous: () => Promise<void>,
  effectLogPath: string,
): RuntimeLayer => {
  const dependencies = Layer.mergeAll(
    infrastructure,
    Layer.succeed(ToolDefinitionStore, {
      definition: () =>
        Effect.promise(rendezvous).pipe(Effect.as(Option.some(definition))),
      all: () => Effect.succeed([definition]),
    }),
    Layer.succeed(SandboxPort, {
      open: () =>
        Effect.succeed({
          handleId: "ah7-cross-connection-sandbox",
          rootPath: "/repo",
          writableRegions: [],
        }),
      close: () => Effect.void,
    }),
    Layer.succeed(ResourceAdmission, {
      admit: () => Effect.succeed({ _tag: "Admitted" as const }),
    }),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: () =>
        Effect.succeed({
          regions: [],
          observedEnvironmentRevision: "env-ah7-cross-connection",
        }),
    }),
    Layer.succeed(Clock, {
      now: () => Effect.succeed("2026-10-07T00:00:00.000Z"),
    }),
  );
  const executor: ToolExecutor = {
    name: definition.name,
    write: true,
    requiresApproval: () => false,
    execute: () =>
      Effect.sync(() => {
        appendFileSync(effectLogPath, `${marker}\n`);
        return {
          settlement: { _tag: "Success" as const },
          observation: { text: "external effect appended", truncated: false },
          resultRef: null,
        };
      }),
  };
  return Layer.mergeAll(
    dependencies,
    Layer.provide(ToolRuntimeLive([executor]), dependencies),
  );
};

const runInvoke = (app: RuntimeLayer) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.match(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(intent, context);
          }),
          {
            onFailure: (error) => ({ _tag: "Rejected" as const, error }),
            onSuccess: (value) => ({ _tag: "Observed" as const, value }),
          },
        ),
        app,
      ),
    ),
  );

const durableCounts = (app: StoreLayer) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          return yield* sql.unsafe<{
            intents: number;
            settled: number;
            settlement_kind: string | null;
          }>(
            "SELECT COUNT(*) AS intents, SUM(CASE WHEN settled_at IS NOT NULL THEN 1 ELSE 0 END) AS settled, MIN(settlement_kind) AS settlement_kind FROM tool_invocations WHERE invocation_id = ?",
            [invocationId],
          );
        }),
        app,
      ),
    ),
  );

const connectionIdentity = (app: StoreLayer) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const databases = yield* sql.unsafe<{
            name: string;
            file: string;
          }>("PRAGMA database_list");
          return {
            client: sql,
            mainFile: databases.find((database) => database.name === "main")
              ?.file,
          };
        }),
        app,
      ),
    ),
  );

describe("AH7 SQLite cross-connection concurrent NonIdempotent invocation", () => {
  it("uses the durable invocation key and admits exactly one external effect across connections", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "arbor-ah7-cross-connection-"),
    );
    directories.push(directory);
    const databaseFile = join(directory, "shared.db");
    const infraA = makeInfrastructure(databaseFile);
    const infraB = makeInfrastructure(databaseFile);
    await Effect.runPromise(
      Effect.scoped(Effect.provide(seedDatabase, infraA)),
    );
    const competing = await Promise.all([
      runIntentInsert(infraA),
      runIntentInsert(infraB),
    ]);
    expect(
      competing.filter((result) => result._tag === "Inserted"),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => result._tag === "Rejected"),
    ).toHaveLength(1);
    const duplicateInsert = competing.find(
      (result) => result._tag === "Rejected",
    );
    expect(duplicateInsert).toBeDefined();
    const persistedAfterInsertRace = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const rows = yield* sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
              [invocationId],
            );
            const columns = yield* sql.unsafe<{
              name: string;
              pk: number;
            }>("PRAGMA table_info(tool_invocations)");
            return { rows, columns };
          }),
          infraA,
        ),
      ),
    );
    expect(duplicateInsert).toMatchObject({
      _tag: "Rejected",
      error: {
        _tag: "PersistenceConstraintViolation",
        repository: "ToolInvocationStore",
      },
    });
    expect(
      persistedAfterInsertRace.columns.find(
        (column) => column.name === "invocation_id",
      )?.pk,
    ).toBe(1);
    expect(Number(persistedAfterInsertRace.rows[0]?.count ?? 0)).toBe(1);
  });

  it("runs both independent ToolRuntime connections against one effect log and settles only one invocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-ah7-cross-runtime-"));
    directories.push(directory);
    const databaseFile = join(directory, "shared.db");
    const effectLogPath = join(directory, "external-effects.log");
    const infraA = makeInfrastructure(databaseFile);
    const infraB = makeInfrastructure(databaseFile);
    await Effect.runPromise(
      Effect.scoped(Effect.provide(seedDatabase, infraA)),
    );
    const [connectionA, connectionB] = await Promise.all([
      connectionIdentity(infraA),
      connectionIdentity(infraB),
    ]);
    expect(connectionA.client).not.toBe(connectionB.client);
    expect(connectionA.mainFile).toBe(resolve(databaseFile));
    expect(connectionB.mainFile).toBe(resolve(databaseFile));

    let arrivals = 0;
    let releaseArrivals: (() => void) | undefined;
    const allRuntimesReady = new Promise<void>((resolve) => {
      releaseArrivals = resolve;
    });
    const waitAtStart = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseArrivals?.();
      await allRuntimesReady;
    };
    const runtimeA = toolRuntimeDependencies(
      infraA,
      waitAtStart,
      effectLogPath,
    );
    const runtimeB = toolRuntimeDependencies(
      infraB,
      waitAtStart,
      effectLogPath,
    );
    const outcomes = await Promise.all([
      runInvoke(runtimeA),
      runInvoke(runtimeB),
    ]);

    const effects = readFileSync(effectLogPath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.length > 0);
    expect(effects).toEqual([marker]);
    const rows = await durableCounts(infraA);
    expect(rows[0]).toMatchObject({
      intents: 1,
      settled: 1,
      settlement_kind: "Success",
    });
    expect(
      outcomes.filter(
        (outcome) =>
          outcome._tag === "Observed" && outcome.value._tag === "Success",
      ),
    ).toHaveLength(1);
    const nonSuccess = outcomes.filter(
      (outcome) =>
        !(outcome._tag === "Observed" && outcome.value._tag === "Success"),
    );
    expect(nonSuccess).toHaveLength(1);
    const loser = nonSuccess[0];
    expect(loser).toBeDefined();
    if (loser?._tag === "Observed") {
      expect(loser.value._tag).toBe("OutcomeUnknown");
    } else {
      expect(loser?.error).toMatchObject({
        _tag: "ToolRuntimeOperationalFailure",
        stage: "IntentJournal",
      });
    }
  });
});
