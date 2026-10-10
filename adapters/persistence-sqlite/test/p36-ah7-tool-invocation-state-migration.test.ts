import { ToolInvocationStore, TransactionPort } from "@arbor/ports";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";
import { runMigrations } from "../src/migrate.js";
import * as migrationExports from "../src/migrations.js";

const makeApp = () => {
  const sqlite = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
  );
};

const runDb = <A>(
  program: Effect.Effect<
    A,
    unknown,
    SqlClient | ToolInvocationStore | TransactionPort
  >,
) => Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

const LEGACY_EXECUTION = "exe_018f2b3c-4d5e-7abc-8def-0123456789a1";
const LEGACY_WORKSPACE = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1";
const LEGACY_PROJECT = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const LEGACY_SESSION = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";
const UNSETTLED_INVOCATION = "tin_018f2b3c-4d5e-7abc-8def-0123456789a1";
const SETTLED_INVOCATION = "tin_118f2b3c-4d5e-7abc-8def-0123456789a1";

const seedLegacyInvocationRows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'AH7 legacy fixture', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
        [LEGACY_PROJECT, LEGACY_WORKSPACE],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [LEGACY_SESSION, LEGACY_WORKSPACE],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
        [LEGACY_WORKSPACE, LEGACY_PROJECT, LEGACY_SESSION],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', 'wrk_fixture', 0,
          NULL, NULL, ?, 't0', NULL, NULL, NULL, NULL)`,
        [LEGACY_EXECUTION, LEGACY_PROJECT, LEGACY_WORKSPACE, LEGACY_SESSION],
      );
      yield* sql.unsafe(
        `INSERT INTO tool_invocations (
          invocation_id, execution_id, workspace_id, tool_name, tool_version,
          side_effect_semantics, arguments_json, resolved_regions_json,
          approval_id, intent_at, settled_at, settlement_kind,
          settlement_json, result_ref
        ) VALUES
          (?, ?, ?, 'shell', '2', 'NonIdempotent', '{"command":"touch marker"}', '[]', NULL, 't1', NULL, NULL, NULL, NULL),
          (?, ?, ?, 'read', '2', 'ReadOnly', '{"target":{"mount":"workspace","path":"a"}}', '[]', NULL, 't1', 't2', 'Success', '{"_tag":"Success"}', NULL)`,
        [
          UNSETTLED_INVOCATION,
          LEGACY_EXECUTION,
          LEGACY_WORKSPACE,
          SETTLED_INVOCATION,
          LEGACY_EXECUTION,
          LEGACY_WORKSPACE,
        ],
      );
    }),
  );
});

describe("AH7-DG-03 P36 ToolInvocation state migration", () => {
  it("backfills legacy invocations to LegacyUnknown and preserves canonical settlement", async () => {
    const p36 = (
      migrationExports as typeof migrationExports & {
        readonly P36_MIGRATIONS?: ReadonlyArray<{
          readonly id: number;
          readonly name: string;
          readonly sql: string;
        }>;
      }
    ).P36_MIGRATIONS;
    expect(
      p36,
      "P36 must be the next forward migration after P35",
    ).toBeDefined();
    if (p36 === undefined) return;

    const program = Effect.gen(function* () {
      yield* runMigrations(migrationExports.P34_MIGRATIONS);
      yield* seedLegacyInvocationRows;
      yield* runMigrations(migrationExports.P35_MIGRATIONS);
      const sql = yield* SqlClient;
      const before = yield* sql.unsafe<{
        invocation_id: string;
        settlement_kind: string | null;
      }>(
        `SELECT invocation_id, settlement_kind FROM tool_invocations
         ORDER BY invocation_id`,
      );
      const applied = yield* runMigrations(p36);
      const after = yield* sql.unsafe<{
        invocation_id: string;
        effect_admission_state: string;
        settlement_kind: string | null;
        settlement_json: string | null;
      }>(
        `SELECT invocation_id, effect_admission_state, settlement_kind,
                settlement_json
           FROM tool_invocations ORDER BY invocation_id`,
      );
      const tx = yield* TransactionPort;
      const store = yield* ToolInvocationStore;
      const legacyNoEffectDenied = yield* Effect.exit(
        tx.transact(
          store.recordNoEffectDenial(
            {
              invocationId: UNSETTLED_INVOCATION as never,
              executionId: LEGACY_EXECUTION as never,
              workspaceId: LEGACY_WORKSPACE as never,
              toolName: "shell",
              toolVersion: "2",
              sideEffectSemantics: "NonIdempotent",
              argumentsJson: '{"command":"touch marker"}',
              resolvedRegions: [],
              approvalId: null,
              intentAt: "t1",
            },
            "InvocationAuthorityDenied" as never,
            "t3",
          ),
        ),
      );
      const replayed = yield* runMigrations(p36);
      const afterLegacyAttempt = yield* sql.unsafe<{
        effect_admission_state: string;
        settlement_kind: string | null;
      }>(
        "SELECT effect_admission_state, settlement_kind FROM tool_invocations WHERE invocation_id = ?",
        [UNSETTLED_INVOCATION],
      );
      return {
        applied,
        before,
        after,
        replayed,
        legacyNoEffectDenied,
        afterLegacyAttempt: afterLegacyAttempt[0],
      };
    });

    const result = await runDb(program);
    expect(result.applied).toBe(1);
    expect(result.replayed).toBe(0);
    expect(Exit.isFailure(result.legacyNoEffectDenied)).toBe(true);
    expect(result.afterLegacyAttempt).toEqual({
      effect_admission_state: "LegacyUnknown",
      settlement_kind: null,
    });
    expect(result.before.map((row) => row.settlement_kind)).toEqual([
      null,
      "Success",
    ]);
    expect(result.after).toEqual([
      {
        invocation_id: UNSETTLED_INVOCATION,
        effect_admission_state: "LegacyUnknown",
        settlement_kind: null,
        settlement_json: null,
      },
      {
        invocation_id: SETTLED_INVOCATION,
        effect_admission_state: "LegacyUnknown",
        settlement_kind: "Success",
        settlement_json: '{"_tag":"Success"}',
      },
    ]);
  });
});
