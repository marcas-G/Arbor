import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { sha256Hex } from "@arbor/ports";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
} from "../../../tests/support/p39-windows-deployment-test.js";
import {
  CURRENT_SCHEMA45_SUFFIX_IDS,
  HISTORICAL_SCHEMA42_SUFFIX_IDS,
  HISTORICAL_SCHEMA42_SUFFIX_MIGRATIONS,
} from "../../../tests/support/schema-prefix-contract.js";
import {
  acquireP39MaintenanceWriterExclusion,
  CURRENT_MIGRATIONS,
  type MigrationFile,
  P38_MIGRATIONS,
  P39_MAINTENANCE_MIGRATION_MANIFEST,
  P39_MAINTENANCE_MIGRATIONS,
  P39_RECONCILIATION_MIGRATION,
  P39WriterLockClient,
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_FINGERPRINT,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
  p39WriterLockLayer,
  prepareP39PrimaryDatabasePath,
  releaseP39WriterPermit,
  runMigrations,
  runP39SqliteMaintenance,
  splitStatements,
  layer as sqliteLayer,
} from "../src/index.js";

const projectId = "prj_cumulative_prefix";
const workspaceId = "ws_cumulative_prefix";
const sessionId = "ses_cumulative_prefix";
const executionId = "exe_cumulative_prefix";
const approvalId = "cap_cumulative_p38";
const legacyApproval = {
  approval_id: approvalId,
  route_kind: "Control",
  project_id: projectId,
  workspace_id: workspaceId,
  execution_id: executionId,
  subject_ref: "legacy:unbound",
  stable_action_id: "core.control.assign-work",
  action_version: "legacy",
  side_effect_semantics: "InternalControl",
  action_digest: "legacy-control-digest",
  arguments_json: "{}",
  target_ref: workspaceId,
  target_resource_space_ids_json: "[]",
  control_basis_digest: "legacy-basis",
  state: "Expired",
  revision: 0,
  requested_at: "2026-09-01T00:00:00.000Z",
  expires_at: "1970-01-01T00:00:00.000Z",
  decision_reason: "MigrationUnprovableSubject",
  binding_proven: 0,
  source_state: "Pending",
} as const;

const cumulativeDescriptors: ReadonlyArray<MigrationFile> = [
  P39_RECONCILIATION_MIGRATION,
  ...HISTORICAL_SCHEMA42_SUFFIX_MIGRATIONS,
];

const descriptorPins: Readonly<
  Record<number, { name: string; sha256: string }>
> = {
  39: {
    name: "ah7_reconciliation_attempts",
    sha256: "6e791168987f23f5c282ce7d6bd2c5b5ad8361942dab968adbcca64aab753aec",
  },
  40: {
    name: "tool_observation_replay_evidence",
    sha256: "3b06ee795277152a3e09a97679c4017b5c7ad3d1009f8cd14b04329a2be002aa",
  },
  41: {
    name: "p41_submitted_decision_binding_attention",
    sha256: "d3ad9133ea28150a271c9867ae390c1f6ba0692f9e6b449817b8aeae2aa1dfed",
  },
  42: {
    name: "project_resource_source_attribution",
    sha256: "a0294a5db440e402a6c32b5a2b596502e059642431157eadcb6be7212224e5aa",
  },
};

const assertDescriptorPrefixAndFingerprint = () => {
  const currentIds = CURRENT_MIGRATIONS.map(({ id }) => id);
  expect(CURRENT_MIGRATIONS.at(-1)?.id).toBe(46);
  expect(currentIds.slice(0, P38_MIGRATIONS.length)).toEqual(
    P38_MIGRATIONS.map(({ id }) => id),
  );
  expect(currentIds.filter((id) => id >= 40)).toEqual([
    ...CURRENT_SCHEMA45_SUFFIX_IDS,
    46,
  ]);
  expect(CURRENT_MIGRATIONS.some(({ id }) => id === 39)).toBe(false);
  expect(P39_MAINTENANCE_MIGRATIONS.map(({ id }) => id)).toEqual([37, 38, 39]);
  expect(P39_MAINTENANCE_MIGRATION_MANIFEST[39]?.sha256).toBe(
    descriptorPins[39]?.sha256,
  );
  expect(cumulativeDescriptors.map(({ id }) => id)).toEqual([39, 40, 41, 42]);
  expect(cumulativeDescriptors.slice(1).map(({ id }) => id)).toEqual(
    HISTORICAL_SCHEMA42_SUFFIX_IDS,
  );

  for (let index = 0; index < cumulativeDescriptors.length; index += 1) {
    const migration = cumulativeDescriptors[index];
    if (migration === undefined)
      throw new Error("missing cumulative descriptor");
    const pin = descriptorPins[migration.id];
    expect(pin, `missing SQL pin for migration ${migration.id}`).toBeDefined();
    expect(migration.name).toBe(pin?.name);
    expect(sha256Hex(migration.sql)).toBe(pin?.sha256);
    expect(migration.id).toBe(39 + index);
    if (migration.requiresUserVersion !== undefined) {
      expect(migration.requiresUserVersion).toBe(migration.id - 1);
    }
  }

  const p41DdlSha256 = sha256Hex(
    P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL.trim(),
  );
  expect(
    sha256Hex(
      [
        "41",
        P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION.name,
        p41DdlSha256,
      ].join("\n"),
    ),
  ).toBe(P41_SUBMITTED_DECISION_BINDING_ATTENTION_FINGERPRINT);
  expect(P41_SUBMITTED_DECISION_BINDING_ATTENTION_FINGERPRINT).toBe(
    "1c4b30b9fc08569c8b50a9333ea115562a2ac93ee81cc869cda97d5fe75149a1",
  );
};

const runPrimary = <A>(
  filename: string,
  effect: Effect.Effect<A, unknown, SqlClient>,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(effect, sqliteLayer({ filename }))),
  );

const seedP38ProjectAndApproval = (filename: string) =>
  runPrimary(
    filename,
    Effect.gen(function* () {
      yield* runMigrations(P38_MIGRATIONS);
      const sql = yield* SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            `INSERT INTO projects (
               project_id, name, root_workspace_id, project_policy,
               project_policy_revision, default_configuration, environment_ref,
               lifecycle, revision, created_at, updated_at
             ) VALUES (?, 'legacy project', ?, '{}', 0, '{}', 'local', 'Open', 0, 't', 't')`,
            [projectId, workspaceId],
          );
          yield* sql.unsafe(
            `INSERT INTO sessions (
               session_id, binding_kind, workspace_id, execution_id,
               context_epoch, created_at
             ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't')`,
            [sessionId, workspaceId],
          );
          yield* sql.unsafe(
            `INSERT INTO workspaces (
               workspace_id, project_id, parent_workspace_id, name,
               responsibility_definition, responsibility_revision,
               resource_boundary, resource_boundary_revision, agent_binding,
               primary_session_id, current_work_id, workspace_policy,
               workspace_policy_revision, revision, lifecycle, created_at,
               updated_at
             ) VALUES (?, ?, NULL, 'root', '{}', 0,
                       '{"basisResponsibilityRevision":0,"addresses":[]}', 0,
                       '{}', ?, NULL, '{}', 0, 0, 'Active', 't', 't')`,
            [workspaceId, projectId, sessionId],
          );
          yield* sql.unsafe(
            `INSERT INTO executions (
               execution_id, project_id, binding_kind, workspace_id,
               episode_kind, episode_ref, episode_revision, parent_execution_id,
               mission, session_id, admitted_at, stop_requested_at,
               settlement_kind, settlement_json, settled_at
             ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
                       'cumulative-prefix qualification', ?, 't', NULL, NULL,
                       NULL, NULL)`,
            [executionId, projectId, workspaceId, sessionId],
          );
          yield* sql.unsafe(
            `INSERT INTO action_approvals (
               approval_id, route_kind, project_id, workspace_id, execution_id,
               subject_ref, stable_action_id, action_version,
               side_effect_semantics, action_digest, arguments_json, target_ref,
               target_resource_space_ids_json, control_basis_digest, state,
               revision, requested_at, expires_at, decision_reason,
               binding_proven, source_state
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            Object.values(legacyApproval),
          );
        }),
      );
      const columns = yield* sql.unsafe<{ name: string }>(
        "PRAGMA table_info(projects)",
      );
      const version = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      return {
        version: Number(version[0]?.user_version ?? 0),
        hasResourceSource: columns.some(
          ({ name }) => name === "resource_source_json",
        ),
      };
    }),
  );

const withP39MaintenanceWriter = <A>(
  filename: string,
  effect: Effect.Effect<A, unknown, SqlClient>,
) => {
  const prepared = prepareP39PrimaryDatabasePath(filename);
  if (!("databaseFilename" in prepared)) {
    throw new Error(`P39 test DB path rejected: ${prepared.code}`);
  }
  const infrastructure = Layer.mergeAll(
    sqliteLayer({ filename: prepared.databaseFilename }),
    p39WriterLockLayer(prepared.writerLockFilename),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.acquireUseRelease(
          acquireP39MaintenanceWriterExclusion(),
          () => effect,
          releaseP39WriterPermit,
        ),
        infrastructure,
      ),
    ),
  );
};

const crashDescriptorTransaction = (
  filename: string,
  migration: MigrationFile,
  expectedVersion: number,
) =>
  withP39MaintenanceWriter(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const before = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      expect(Number(before[0]?.user_version ?? 0)).toBe(expectedVersion);
      if (migration.foreignKeysOff === true) {
        yield* sql.unsafe("PRAGMA foreign_keys = OFF");
        yield* sql.unsafe("PRAGMA legacy_alter_table = ON");
      }
      const result = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            for (const statement of splitStatements(migration.sql)) {
              yield* sql.unsafe(statement);
            }
            yield* sql.unsafe(`PRAGMA user_version = ${migration.id}`);
            return yield* Effect.fail(
              new Error(
                `injected cumulative migration crash after ${migration.id}`,
              ),
            );
          }),
        ),
      );
      if (migration.foreignKeysOff === true) {
        yield* sql.unsafe("PRAGMA legacy_alter_table = OFF");
        yield* sql.unsafe("PRAGMA foreign_keys = ON");
      }
      return result;
    }),
  );

const applyDescriptorAndRecheckNoOp = (
  filename: string,
  migration: MigrationFile,
  expectedVersion: number,
) =>
  withP39MaintenanceWriter(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const before = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      expect(Number(before[0]?.user_version ?? 0)).toBe(expectedVersion);
      expect(migration.id).toBe(expectedVersion + 1);
      if (migration.requiresUserVersion !== undefined) {
        expect(migration.requiresUserVersion).toBe(expectedVersion);
      }
      const applied = yield* runMigrations([migration]);
      const noOp = yield* runMigrations([migration]);
      const after = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const violations = yield* sql.unsafe("PRAGMA foreign_key_check");
      return {
        applied,
        noOp,
        version: Number(after[0]?.user_version ?? 0),
        foreignKeyViolations: violations.length,
      };
    }),
  );

const expectP42PrefixGate = (filename: string, expectedVersion: number) =>
  withP39MaintenanceWriter(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const before = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      expect(Number(before[0]?.user_version ?? 0)).toBe(expectedVersion);
      const rejected = yield* Effect.flip(
        runMigrations([P42_PROJECT_RESOURCE_SOURCE_MIGRATION]),
      );
      expect(rejected).toMatchObject({
        _tag: "SqliteAdapterError",
        message: expect.stringContaining("requires database user_version 41"),
      });
      const after = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      return Number(after[0]?.user_version ?? 0);
    }),
  );

const expectVersionAndResourceColumn = (
  filename: string,
  expectedVersion: number,
  expectedColumn: boolean,
) =>
  runPrimary(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const version = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const columns = yield* sql.unsafe<{ name: string; notnull: number }>(
        "PRAGMA table_info(projects)",
      );
      const source = columns.find(
        ({ name }) => name === "resource_source_json",
      );
      return {
        version: Number(version[0]?.user_version ?? 0),
        sourceColumn: source,
        hasSource: source !== undefined,
        sourceNotNull: source?.notnull === 1,
      };
    }),
  ).then((result) => {
    expect(result.version).toBe(expectedVersion);
    expect(result.hasSource).toBe(expectedColumn);
    return result;
  });

const expectP39AdmissionGuard = (filename: string) =>
  runPrimary(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name = 'effect_attempt_admission_monotone'`,
      );
      return rows.length;
    }),
  ).then((count) => expect(count).toBe(1));

const summarizeLockFailure = (cause: unknown, depth = 0): string => {
  if (depth > 3) return "nested failure";
  if (typeof cause !== "object" || cause === null) return "unknown failure";
  const fields = cause as Record<string, unknown>;
  const labels = [fields._tag, fields.code, fields.reasonCode].filter(
    (value): value is string => typeof value === "string",
  );
  if (
    typeof fields.message === "string" &&
    /^(?:database (?:is )?(?:locked|busy)|sqlite_busy)$/iu.test(
      fields.message.trim(),
    )
  ) {
    labels.push(fields.message.trim());
  }
  if ("cause" in fields) {
    labels.push(summarizeLockFailure(fields.cause, depth + 1));
  }
  return labels.join("/") || "unclassified structured failure";
};

describe("test-only P39 maintenance cumulative prefix qualification 0039–0042", () => {
  it("applies the configured writer-lock busy timeout before initialization reads", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".p39-writer-lock-timeout-",
    );
    let blocker: ChildProcess | undefined;
    let blockerExit: Promise<void> | undefined;
    try {
      const primary = join(directory, "primary.sqlite");
      createP39PrivateTestFile(primary);
      const prepared = prepareP39PrimaryDatabasePath(primary);
      if (!("writerLockFilename" in prepared)) {
        throw new Error(`P39 test DB path rejected: ${prepared.code}`);
      }
      const acquireAndRelease = () =>
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const writerLock = yield* P39WriterLockClient;
                const permit = yield* writerLock.acquire(
                  "MaintenanceExclusive",
                );
                yield* writerLock.release(permit);
              }),
              p39WriterLockLayer(prepared.writerLockFilename, 20_000),
            ),
          ),
        );

      await acquireAndRelease();
      const blockerScript = [
        'import { DatabaseSync } from "node:sqlite";',
        "const database = new DatabaseSync(process.argv[1]);",
        'database.exec("BEGIN EXCLUSIVE");',
        'process.stdout.write("LOCKED\\n");',
        'setTimeout(() => { database.exec("ROLLBACK"); database.close(); }, 16_000);',
      ].join("\n");
      blocker = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          blockerScript,
          prepared.writerLockFilename,
        ],
        { cwd: process.cwd(), windowsHide: true },
      );
      let blockerOutput = "";
      blockerExit = new Promise((resolve) => {
        blocker?.once("close", () => resolve());
      });
      const blockerReady = new Promise<void>((resolve, reject) => {
        blocker?.stdout?.setEncoding("utf8");
        blocker?.stdout?.on("data", (chunk: string) => {
          blockerOutput += chunk;
          if (blockerOutput.includes("LOCKED\n")) resolve();
        });
        blocker?.once("error", reject);
        blocker?.once("close", (code) => {
          if (!blockerOutput.includes("LOCKED\n")) {
            reject(
              new Error(`writer-lock blocker exited before ready: ${code}`),
            );
          }
        });
      });
      await blockerReady;
      const contender = acquireAndRelease().then(
        () => ({ _tag: "Acquired" as const }),
        (cause: unknown) => ({ _tag: "Failed" as const, cause }),
      );
      const result = await contender;
      await blockerExit;
      blocker = undefined;
      expect(
        result._tag,
        result._tag === "Failed"
          ? summarizeLockFailure(result.cause)
          : "writer lock acquired after blocker release",
      ).toBe("Acquired");
    } finally {
      if (blocker !== undefined) {
        blocker.kill();
        await blockerExit;
      }
      removeP39PrivateTestDirectory(directory);
    }
  }, 120_000);

  it("rolls back/restarts each exact descriptor and preserves the P38 Project/approval prefix through 0042", async () => {
    assertDescriptorPrefixAndFingerprint();
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".p39-42-cumulative-qualification-",
    );
    const filename = join(directory, "primary.sqlite");
    const sidecar = join(directory, "reports.sqlite");
    try {
      createP39PrivateTestFile(filename);
      const seeded = await seedP38ProjectAndApproval(filename);
      expect(seeded).toEqual({ version: 38, hasResourceSource: false });
      await expectP42PrefixGate(filename, 38);

      const p39Crash = await crashDescriptorTransaction(
        filename,
        P39_RECONCILIATION_MIGRATION,
        38,
      );
      expect(Exit.isFailure(p39Crash)).toBe(true);
      await expectVersionAndResourceColumn(filename, 38, false);

      await Effect.runPromise(
        runP39SqliteMaintenance({
          primaryFilename: filename,
          sidecarFilename: sidecar,
          protectedStoreFilenames: [],
        }),
      );
      await expectVersionAndResourceColumn(filename, 39, false);
      await expectP39AdmissionGuard(filename);
      await expectP42PrefixGate(filename, 39);

      const p40Crash = await crashDescriptorTransaction(
        filename,
        P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
        39,
      );
      expect(Exit.isFailure(p40Crash)).toBe(true);
      await expectVersionAndResourceColumn(filename, 39, false);
      const p40 = await applyDescriptorAndRecheckNoOp(
        filename,
        P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
        39,
      );
      expect(p40).toEqual({
        applied: 1,
        noOp: 0,
        version: 40,
        foreignKeyViolations: 0,
      });
      await expectP39AdmissionGuard(filename);

      await expectP42PrefixGate(filename, 40);

      const p41Crash = await crashDescriptorTransaction(
        filename,
        P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
        40,
      );
      expect(Exit.isFailure(p41Crash)).toBe(true);
      await expectVersionAndResourceColumn(filename, 40, false);
      const p41 = await applyDescriptorAndRecheckNoOp(
        filename,
        P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
        40,
      );
      expect(p41).toEqual({
        applied: 1,
        noOp: 0,
        version: 41,
        foreignKeyViolations: 0,
      });
      await expectP39AdmissionGuard(filename);

      const p42Crash = await crashDescriptorTransaction(
        filename,
        P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
        41,
      );
      expect(Exit.isFailure(p42Crash)).toBe(true);
      await expectVersionAndResourceColumn(filename, 41, false);
      const p42 = await applyDescriptorAndRecheckNoOp(
        filename,
        P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
        41,
      );
      expect(p42).toEqual({
        applied: 1,
        noOp: 0,
        version: 42,
        foreignKeyViolations: 0,
      });
      await expectP39AdmissionGuard(filename);

      const final = await runPrimary(
        filename,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const columns = yield* sql.unsafe<{
            name: string;
            notnull: number;
          }>("PRAGMA table_info(projects)");
          const projects = yield* sql.unsafe<{
            project_id: string;
            resource_source_json: string;
          }>(
            "SELECT project_id, resource_source_json FROM projects WHERE project_id = ?",
            [projectId],
          );
          const approval = yield* sql.unsafe<{
            approval_id: string;
            route_kind: string;
            state: string;
            source_state: string;
          }>(
            "SELECT approval_id, route_kind, state, source_state FROM action_approvals WHERE approval_id = ?",
            [approvalId],
          );
          const p39Objects = yield* sql.unsafe<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE name IN (
              'tool_invocation_recovery_bindings',
              'tool_invocation_effect_attempts',
              'tool_reconciliation_facts',
              'effect_attempt_admission_monotone',
              'recovery_binding_no_update',
              'tool_invocation_reconciliation_fact_required_insert'
            ) ORDER BY name`,
          );
          const p40Columns = yield* sql.unsafe<{ name: string }>(
            "PRAGMA table_info(tool_invocations)",
          );
          const p40Guards = yield* sql.unsafe<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'trigger'
               AND name IN ('tool_invocations_observation_insert_guard',
                            'tool_invocations_observation_update_guard')
             ORDER BY name`,
          );
          const p41Objects = yield* sql.unsafe<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE name IN (
              'submitted_decision_binding_attention_facts',
              'submitted_decision_binding_attention_rows'
            ) ORDER BY name`,
          );
          const p41Null = yield* Effect.exit(
            sql.unsafe(
              `INSERT INTO submitted_decision_binding_attention_facts (
                 attention_fact_id, event_id, project_id, execution_id,
                 workspace_id, logical_step_no, repair_attempt,
                 provider_turn_id, logical_action_id, failure_code,
                 first_detected_at
               ) VALUES (NULL, 'evt_null_p41', ?, ?, ?, 0, 0,
                         'ptn_prefix', 'lac_prefix_null',
                         'StepManifestMismatch', 't')`,
              [projectId, executionId, workspaceId],
            ),
          );
          const p41FactsAfterNull = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM submitted_decision_binding_attention_facts",
          );
          yield* sql.unsafe(
            `INSERT INTO submitted_decision_binding_attention_facts (
               attention_fact_id, event_id, project_id, execution_id,
               workspace_id, logical_step_no, repair_attempt,
               provider_turn_id, logical_action_id, failure_code,
               first_detected_at
             ) VALUES (?, 'evt_prefix_p41', ?, ?, ?, 0, 0,
                       'ptn_prefix', 'lac_prefix',
                       'StepManifestMismatch', 't')`,
            [`att_${"a".repeat(64)}`, projectId, executionId, workspaceId],
          );
          yield* sql.unsafe(
            `INSERT INTO submitted_decision_binding_attention_rows (
               project_id, attention_fact_id, workspace_id
             ) VALUES (?, ?, ?)`,
            [projectId, `att_${"a".repeat(64)}`, workspaceId],
          );
          const p41Markers = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM submitted_decision_binding_attention_rows WHERE project_id = ?",
            [projectId],
          );
          const sourceColumn = columns.find(
            ({ name }) => name === "resource_source_json",
          );
          const foreignKeys = yield* sql.unsafe("PRAGMA foreign_key_check");
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          return {
            project: projects[0],
            approval: approval[0],
            sourceNotNull: sourceColumn?.notnull === 1,
            p39Objects: p39Objects.map(({ name }) => name),
            hasP40Columns: [
              "observation_format_version",
              "observation_json",
              "observation_sha256",
            ].every((name) =>
              p40Columns.some((column) => column.name === name),
            ),
            p40Guards: p40Guards.map(({ name }) => name),
            p41Objects: p41Objects.map(({ name }) => name),
            p41Null,
            p41FactsAfterNull: Number(p41FactsAfterNull[0]?.count ?? 0),
            p41MarkerCount: Number(p41Markers[0]?.count ?? 0),
            foreignKeyViolations: foreignKeys.length,
            version: Number(version[0]?.user_version ?? 0),
          };
        }),
      );
      expect(final).toMatchObject({
        project: {
          project_id: projectId,
          resource_source_json: '{"_tag":"LegacyUnknown"}',
        },
        approval: {
          approval_id: approvalId,
          route_kind: "Control",
          state: "Expired",
          source_state: "Pending",
        },
        sourceNotNull: true,
        p39Objects: [
          "effect_attempt_admission_monotone",
          "recovery_binding_no_update",
          "tool_invocation_effect_attempts",
          "tool_invocation_reconciliation_fact_required_insert",
          "tool_invocation_recovery_bindings",
          "tool_reconciliation_facts",
        ],
        hasP40Columns: true,
        p40Guards: [
          "tool_invocations_observation_insert_guard",
          "tool_invocations_observation_update_guard",
        ],
        p41Objects: [
          "submitted_decision_binding_attention_facts",
          "submitted_decision_binding_attention_rows",
        ],
        p41FactsAfterNull: 0,
        p41MarkerCount: 1,
        foreignKeyViolations: 0,
        version: 42,
      });
      expect(Exit.isFailure(final.p41Null)).toBe(true);
      if (Exit.isFailure(final.p41Null)) {
        expect(JSON.stringify(final.p41Null.cause)).toContain('"errcode":1299');
      }
    } finally {
      removeP39PrivateTestDirectory(directory);
    }
  }, 300_000);
});
