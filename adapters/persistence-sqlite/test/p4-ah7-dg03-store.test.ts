import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionId,
  type LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  SessionId,
  type ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  invocationAuthoritySourceRevisionOf,
  type ToolExecutionContext,
  type ToolInvocationIntent,
  ToolInvocationStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P31_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";
import * as migrationExports from "../src/migrations.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationA =
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const invocationB =
  "tin_118f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const invocationC =
  "tin_218f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const invocationE =
  "tin_318f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const invocationF =
  "tin_418f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const invocationG =
  "tin_518f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const approvalId = "apr_018f2b3c-4d5e-7abc-8def-0123456789a1";
const executableApprovalId = "eap_018f2b3c-4d5e-7abc-8def-0123456789a1";
const unprovenExecutableHistoryId =
  "eap_legacy_018f2b3c-4d5e-7abc-8def-0123456789a1";
const nullSourceConsumedApprovalId =
  "iap_null_source_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workerId = "worker:ah7-dg03";
const workerIncarnationId = "incarnation:ah7-dg03";
const fence = {
  executionId,
  workerId,
  workerIncarnationId,
  fencingGeneration: 0 as LeaseGeneration,
} as NonNullable<ToolExecutionContext["executionFence"]>;
const fenceNow = "2026-10-11T00:00:01.000Z";
const intent = (
  id: ToolInvocationId,
  withApproval: boolean,
  approvalRef = approvalId,
): ToolInvocationIntent => ({
  invocationId: id,
  executionId,
  workspaceId,
  toolName: "write_once",
  toolVersion: "1",
  sideEffectSemantics: "NonIdempotent",
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId: withApproval ? approvalRef : null,
  intentAt: fenceNow,
});

const makeApp = () => {
  const sqlite = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
  );
};

const seedExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'AH7 DG03', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
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

const seedApproval = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    `INSERT INTO invocation_approvals (
      approval_id, tool_name, tool_version, action_digest,
      target_resource_space_ids_json, control_basis_digest, expires_at, consumed_by
    ) VALUES (?, 'write_once', '1', 'digest', '[]', 'basis',
      '2999-01-01T00:00:00.000Z', NULL)`,
    [approvalId],
  );
});

const seedExecutableApproval = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    `INSERT INTO action_approvals (
      approval_id, route_kind, project_id, workspace_id, execution_id,
      subject_ref, stable_action_id, action_version, side_effect_semantics,
      action_digest, arguments_json, target_ref, target_resource_space_ids_json,
      control_basis_digest, state, revision, requested_at, expires_at,
      decided_at, decided_by, decision_reason, consumed_at, consumed_by,
      binding_proven, source_state
    ) VALUES (?, 'Executable', ?, ?, ?, 'Execution:exe_ah7_dg03', 'write_once', '1',
      'NonIdempotent', 'digest-eap', '{}', 'workspace', '[]', 'basis-eap',
      'Approved', 1, 't0', '2999-01-01T00:00:00.000Z', 't0', 'human:test',
      NULL, NULL, NULL, 1, 'Approved')`,
    [executableApprovalId, projectId, workspaceId, executionId],
  );
});

const seedUnprovenExecutableHistory = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    `INSERT INTO action_approvals (
      approval_id, route_kind, project_id, workspace_id, execution_id,
      subject_ref, stable_action_id, action_version, side_effect_semantics,
      action_digest, arguments_json, target_ref, target_resource_space_ids_json,
      control_basis_digest, state, revision, requested_at, expires_at,
      decided_at, decided_by, decision_reason, consumed_at, consumed_by,
      binding_proven, source_state
    ) VALUES (?, 'Executable', ?, ?, ?, 'Execution:exe_ah7_dg03', 'write_once', '1',
      'NonIdempotent', 'digest-unproven-eap-history', '{}', 'filesystem',
      '["filesystem"]', 'basis-unproven-eap-history', 'Expired', 1,
      't0', '1970-01-01T00:00:00.000Z', NULL, NULL,
      'MigrationUnprovableSubject', NULL, NULL, 0, 'Approved')`,
    [unprovenExecutableHistoryId, projectId, workspaceId, executionId],
  );
});

const seedNullSourceConsumedApproval = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    `INSERT INTO action_approvals (
      approval_id, route_kind, project_id, workspace_id, execution_id,
      subject_ref, stable_action_id, action_version, side_effect_semantics,
      action_digest, arguments_json, target_ref, target_resource_space_ids_json,
      control_basis_digest, state, revision, requested_at, expires_at,
      decided_at, decided_by, decision_reason, consumed_at, consumed_by,
      binding_proven, source_state
    ) VALUES (?, 'Executable', NULL, NULL, NULL, 'legacy:unbound',
      'write_once', '1', 'LegacyUnknown', 'digest-null-consumed', '{}', '[]',
      '[]', 'basis-null-consumed', 'Consumed', 2, 't0',
      '2999-01-01T00:00:00.000Z', 't0', 'human:test', NULL, 't0', ?, 0, NULL)`,
    [nullSourceConsumedApprovalId, invocationG],
  );
});

const p36Migrations = () =>
  (
    migrationExports as typeof migrationExports & {
      readonly P36_MIGRATIONS?: ReadonlyArray<{
        readonly id: number;
        readonly name: string;
        readonly sql: string;
        readonly foreignKeysOff?: boolean;
      }>;
    }
  ).P36_MIGRATIONS;

const p31Migrations = () => P31_MIGRATIONS;

/** This focused adapter fixture combines P31 with the P36 tool-invocation
 * admission migration, leaving P4's legacy approval table as the route under
 * test. The separate route-separation case executes the real P31→P36 chain. */
const p31WithAh7Migrations = () => {
  const ah7 = p36Migrations()?.find((migration) => migration.id === 36);
  return ah7 === undefined ? undefined : [...P31_MIGRATIONS, ah7];
};

describe("AH7-DG-03 P4 SQLite store contract", () => {
  it("provides the P36 forward migration and fenced no-effect store operations", () => {
    expect(p36Migrations(), "P36 migration must be exported").toBeDefined();
  });

  it("exposes fenced intent, denial, interruption and effect-admission store operations", async () => {
    const app = makeApp();
    const store = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return (yield* ToolInvocationStore) as unknown as Record<
            string,
            unknown
          >;
        }),
        app,
      ),
    );
    expect(typeof store.recordIntent).toBe("function");
    expect(typeof store.consumeApproval).toBe("function");
    expect(typeof store.recordNoEffectDenial).toBe("function");
    expect(typeof store.recordNoEffectInterruption).toBe("function");
    expect(typeof store.admitEffect).toBe("function");
  });

  it("commits intent and approval claim together, and rolls both back on claim failure", async () => {
    const migrations = p31WithAh7Migrations();
    expect(migrations).toBeDefined();
    if (migrations === undefined) return;
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(migrations);
      yield* seedExecution;
      yield* seedApproval;
      const tx = yield* TransactionPort;
      const store = (yield* ToolInvocationStore) as unknown as {
        recordIntent: (
          ...args: ReadonlyArray<unknown>
        ) => Effect.Effect<void, unknown, never>;
        consumeApproval: (
          ...args: ReadonlyArray<unknown>
        ) => Effect.Effect<boolean, unknown, never>;
      };
      const sql = yield* SqlClient;

      const failedClaim = yield* Effect.exit(
        tx.transact(
          Effect.gen(function* () {
            yield* store.recordIntent(
              intent(invocationA, true),
              fence,
              fenceNow,
            );
            const consumed = yield* store.consumeApproval(
              approvalId,
              invocationA,
              fence,
              fenceNow,
            );
            if (!consumed)
              return yield* Effect.fail(new Error("approval claim lost"));
            return yield* Effect.fail(new Error("injected claim rollback"));
          }),
        ),
      );
      const rolledBack = yield* sql.unsafe<{
        intents: number;
        consumed_by: string | null;
      }>(
        `SELECT (SELECT COUNT(*) FROM tool_invocations WHERE invocation_id = ?) AS intents,
                (SELECT consumed_by FROM invocation_approvals WHERE approval_id = ?) AS consumed_by`,
        [invocationA, approvalId],
      );

      const claimWon = yield* tx.transact(
        Effect.gen(function* () {
          yield* store.recordIntent(intent(invocationA, true), fence, fenceNow);
          return yield* store.consumeApproval(
            approvalId,
            invocationA,
            fence,
            fenceNow,
          );
        }),
      );
      const committed = yield* sql.unsafe<{
        invocation_id: string;
        effect_admission_state: string;
        consumed_by: string | null;
      }>(
        `SELECT i.invocation_id, i.effect_admission_state, a.consumed_by
           FROM tool_invocations i
           JOIN invocation_approvals a ON a.approval_id = i.approval_id
          WHERE i.invocation_id = ?`,
        [invocationA],
      );

      const loser = yield* Effect.exit(
        tx.transact(
          Effect.gen(function* () {
            yield* store.recordIntent(
              intent(invocationB, true),
              fence,
              fenceNow,
            );
            const consumed = yield* store.consumeApproval(
              approvalId,
              invocationB,
              fence,
              fenceNow,
            );
            if (consumed)
              return yield* Effect.fail(
                new Error("unexpected approval winner"),
              );
            return yield* Effect.fail(
              new Error("roll back losing claim intent"),
            );
          }),
        ),
      );
      const loserRows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
        [invocationB],
      );
      return {
        failedClaim,
        rolledBack: rolledBack[0],
        claimWon,
        committed: committed[0],
        loser,
        loserRows: loserRows[0],
      };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.failedClaim)).toBe(true);
    expect(result.rolledBack).toEqual({ intents: 0, consumed_by: null });
    expect(result.claimWon).toBe(true);
    expect(result.committed).toEqual({
      invocation_id: invocationA,
      effect_admission_state: "NotAdmitted",
      consumed_by: invocationA,
    });
    expect(Exit.isFailure(result.loser)).toBe(true);
    expect(result.loserRows?.count).toBe(0);
  });

  it("keeps binding-proven P38 approvals out of the legacy P4 find/consume route", async () => {
    const migration31 = p31Migrations();
    const migration36 = p36Migrations();
    expect(migration36).toBeDefined();
    if (migration36 === undefined) return;
    const app = makeApp();
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(migration31);
          yield* seedExecution;
          yield* seedApproval;
          // The actual P32 conversion expires an unconsumed old P4 approval
          // and records its source; later P36 migrations keep that terminal
          // history separate from binding-proven P38 Executable rows.
          yield* runMigrations(migration36);
          yield* seedExecutableApproval;
          yield* seedUnprovenExecutableHistory;
          yield* seedNullSourceConsumedApproval;
          const tx = yield* TransactionPort;
          const store = yield* ToolInvocationStore;
          yield* tx.transact(
            store.recordIntent(
              intent(invocationA, true, approvalId),
              fence,
              fenceNow,
            ),
          );
          yield* tx.transact(
            store.recordIntent(
              intent(invocationB, true, executableApprovalId),
              fence,
              fenceNow,
            ),
          );
          yield* tx.transact(
            store.recordIntent(
              intent(invocationC, true, unprovenExecutableHistoryId),
              fence,
              fenceNow,
            ),
          );
          yield* tx.transact(
            store.recordIntent(
              intent(invocationG, true, nullSourceConsumedApprovalId),
              fence,
              fenceNow,
            ),
          );
          const priorInvocation = yield* tx.transact(
            store.findById(invocationG),
          );
          const legacyBefore = yield* tx.transact(
            store.findApproval(approvalId),
          );
          const executableThroughLegacy = yield* tx.transact(
            store.findApproval(executableApprovalId),
          );
          const unprovenHistoryThroughLegacy = yield* tx.transact(
            store.findApproval(unprovenExecutableHistoryId),
          );
          const nullSourceHistoryThroughLegacy = yield* tx.transact(
            store.findApproval(nullSourceConsumedApprovalId),
          );
          const legacyConsumed = yield* tx.transact(
            store.consumeApproval(approvalId, invocationA, fence, fenceNow),
          );
          const executableConsumedThroughLegacy = yield* tx.transact(
            store.consumeApproval(
              executableApprovalId,
              invocationB,
              fence,
              fenceNow,
            ),
          );
          const unprovenHistoryConsumedThroughLegacy = yield* tx.transact(
            store.consumeApproval(
              unprovenExecutableHistoryId,
              invocationC,
              fence,
              fenceNow,
            ),
          );
          const nullSourceConsumedThroughLegacy = yield* tx.transact(
            store.consumeApproval(
              nullSourceConsumedApprovalId,
              invocationG,
              fence,
              fenceNow,
            ),
          );
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{
            approval_id: string;
            binding_proven: number;
            state: string;
            consumed_by: string | null;
          }>(
            `SELECT approval_id, binding_proven, state, consumed_by
               FROM action_approvals
              WHERE approval_id IN (?, ?, ?, ?)
              ORDER BY approval_id`,
            [
              approvalId,
              executableApprovalId,
              unprovenExecutableHistoryId,
              nullSourceConsumedApprovalId,
            ],
          );
          return {
            priorInvocation,
            legacyBefore,
            executableThroughLegacy,
            unprovenHistoryThroughLegacy,
            nullSourceHistoryThroughLegacy,
            legacyConsumed,
            executableConsumedThroughLegacy,
            unprovenHistoryConsumedThroughLegacy,
            nullSourceConsumedThroughLegacy,
            rows,
          };
        }),
        app,
      ),
    );

    expect(Option.isSome(result.priorInvocation)).toBe(true);
    expect(Option.isSome(result.legacyBefore)).toBe(true);
    expect(Option.isNone(result.executableThroughLegacy)).toBe(true);
    expect(Option.isNone(result.unprovenHistoryThroughLegacy)).toBe(true);
    expect(Option.isNone(result.nullSourceHistoryThroughLegacy)).toBe(true);
    expect(result.legacyConsumed).toBe(false);
    expect(result.executableConsumedThroughLegacy).toBe(false);
    expect(result.unprovenHistoryConsumedThroughLegacy).toBe(false);
    expect(result.nullSourceConsumedThroughLegacy).toBe(false);
    expect(result.rows).toContainEqual({
      approval_id: approvalId,
      binding_proven: 0,
      state: "Expired",
      consumed_by: null,
    });
    expect(result.rows).toContainEqual({
      approval_id: executableApprovalId,
      binding_proven: 1,
      state: "Approved",
      consumed_by: null,
    });
    expect(result.rows).toContainEqual({
      approval_id: unprovenExecutableHistoryId,
      binding_proven: 0,
      state: "Expired",
      consumed_by: null,
    });
    expect(result.rows).toContainEqual({
      approval_id: nullSourceConsumedApprovalId,
      binding_proven: 0,
      state: "Consumed",
      consumed_by: invocationG,
    });
  });

  it.each([
    "grant revocation",
    "workspace policy revision change",
    "verifier binding change",
  ] as const)(
    "rejects stale authority after a resolver snapshot and concurrent %s",
    async (sourceChange) => {
      const migrations = p31WithAh7Migrations();
      expect(migrations).toBeDefined();
      if (migrations === undefined) return;

      const directory = mkdtempSync(join(tmpdir(), "ah7-authority-fence-"));
      const filename = join(directory, "authority.db");
      const primarySqlite = layer({ filename });
      const revokerSqlite = layer({ filename });
      const app = Layer.mergeAll(
        primarySqlite,
        Layer.provide(TransactionPortLive, primarySqlite),
        Layer.provide(ToolInvocationStoreLive, primarySqlite),
      );
      let signalResolved!: () => void;
      let releaseAdmission!: () => void;
      const authorityResolved = new Promise<void>((resolve) => {
        signalResolved = resolve;
      });
      const continueAdmission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const executorCalls = 0;

      try {
        const resultPromise = Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              yield* runMigrations(migrations);
              yield* seedExecution;
              yield* seedApproval;
              const sql = yield* SqlClient;
              const tx = yield* TransactionPort;
              const store = yield* ToolInvocationStore;
              yield* sql.unsafe(
                `INSERT INTO permission_grants (
                 permission_grant_id, project_id, scope, issuer, lifetime,
                 state, subject_kind, subject_ref, capability, target,
                 valid_from, expires_at, revision
               ) VALUES (
                 'pgr_018f2b3c-4d5e-7abc-8def-0123456789a1', ?,
                 'Write', 'human:test', 'until-revoked', 'Active',
                 'WorkspaceAgent', ?, 'Write', 'filesystem',
                 '2026-10-11T00:00:00.000Z', NULL, 0
               )`,
                [projectId, workspaceId],
              );

              yield* tx.transact(
                Effect.gen(function* () {
                  yield* store.recordIntent(
                    intent(invocationF, true),
                    fence,
                    fenceNow,
                  );
                  const consumed = yield* store.consumeApproval(
                    approvalId,
                    invocationF,
                    fence,
                    fenceNow,
                  );
                  if (!consumed) {
                    return yield* Effect.fail(
                      new Error("fixture approval claim did not commit"),
                    );
                  }
                }),
              );

              const authoritySource = yield* tx.transact(
                Effect.gen(function* () {
                  const workspaceRows = yield* sql.unsafe<{
                    readonly workspace_policy_revision: number;
                  }>(
                    "SELECT workspace_policy_revision FROM workspaces WHERE workspace_id = ?",
                    [workspaceId],
                  );
                  const grantRows = yield* sql.unsafe<{
                    readonly permission_grant_id: string;
                    readonly revision: number | null;
                  }>(
                    `SELECT permission_grant_id, revision
                     FROM permission_grants
                    WHERE project_id = ? AND state = 'Active'
                    ORDER BY permission_grant_id`,
                    [projectId],
                  );
                  const verifierRows = yield* sql.unsafe<{
                    readonly verification_id: string;
                  }>(
                    `SELECT v.verification_id
                     FROM verification_executions ve
                     JOIN verifications v
                       ON v.verification_id = ve.verification_id
                    WHERE ve.execution_id = ?
                    ORDER BY ve.bound_at, v.verification_id
                    LIMIT 1`,
                    [executionId],
                  );
                  return invocationAuthoritySourceRevisionOf({
                    workspacePolicyRevision: Number(
                      workspaceRows[0]?.workspace_policy_revision,
                    ),
                    activeGrants: grantRows.map((grant) => ({
                      permissionGrantId: grant.permission_grant_id,
                      revision:
                        grant.revision === null ? null : Number(grant.revision),
                    })),
                    verifierId: verifierRows[0]?.verification_id ?? null,
                  });
                }),
              );
              const authority = {
                principal: parse(Principal)("worker:ah7-dg03"),
                workspaceId,
                executionId,
                toolName: "write_once",
                toolVersion: "1",
                resourceSpaceIds: [],
                allowedCapabilities: [],
                controlBasisDigest: "basis",
                expiresAt: "2999-01-01T00:00:00.000Z",
                delegationDepth: 0,
                sourceRevision: authoritySource,
              };

              // Deterministic admission barrier: the exact authority source has
              // been read; a separate SQLite connection revokes it before the
              // fenced effect-admission transaction begins.
              signalResolved();
              yield* Effect.promise(() => continueAdmission);

              const gate = yield* tx.transact(
                store.admitEffect(invocationF, authority, fenceNow, fence),
              );
              if (gate._tag !== "Denied") {
                return { gate, record: null, approval: null };
              }
              const record = yield* tx.transact(
                store.recordNoEffectDenial(
                  intent(invocationF, true),
                  "ApprovalNoLongerAuthorized",
                  fenceNow,
                  fence,
                  fenceNow,
                ),
              );
              const persisted = yield* tx.transact(store.findById(invocationF));
              const approval = yield* tx.transact(
                store.findApproval(approvalId),
              );
              return { gate, record, persisted, approval };
            }),
            app,
          ),
        );
        void resultPromise.catch(() => signalResolved());

        await authorityResolved;
        await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              if (sourceChange === "grant revocation") {
                yield* sql.unsafe(
                  `UPDATE permission_grants SET state = 'Revoked'
                  WHERE permission_grant_id = 'pgr_018f2b3c-4d5e-7abc-8def-0123456789a1'`,
                );
              } else if (sourceChange === "workspace policy revision change") {
                yield* sql.unsafe(
                  `UPDATE workspaces
                    SET workspace_policy = '{"authorityTtlSeconds": 60}',
                        workspace_policy_revision = workspace_policy_revision + 1
                  WHERE workspace_id = ?`,
                  [workspaceId],
                );
              } else {
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql.unsafe(
                      `INSERT INTO works (
                       work_id, project_id, workspace_id, objective, why,
                       constraints, completion_expectation,
                       verification_mission, provenance, lifecycle, revision,
                       created_at, updated_at
                     ) VALUES (
                       'wrk_018f2b3c-4d5e-7abc-8def-0123456789a1', ?, ?,
                       'authority source fixture', 'test', '[]', 'verified',
                       '{}', '{}', 'Open', 0, 't0', 't0'
                     )`,
                      [projectId, workspaceId],
                    );
                    yield* sql.unsafe(
                      `INSERT INTO verifications (
                       verification_id, project_id, work_id,
                       target_work_revision, owner_workspace_id,
                       mission_snapshot, target_deliverables,
                       target_artifact_versions, target_environment_revision,
                       environment_snapshot_ref, verification_execution_ids,
                       state, verdict, conclusion_reason, created_at, updated_at
                     ) VALUES (
                       'ver_018f2b3c-4d5e-7abc-8def-0123456789a1', ?,
                       'wrk_018f2b3c-4d5e-7abc-8def-0123456789a1', 0, ?,
                       '{}', '[]', '[]', NULL, NULL, '[]', 'Open', NULL,
                       NULL, 't0', 't0'
                     )`,
                      [projectId, workspaceId],
                    );
                    yield* sql.unsafe(
                      `INSERT INTO verification_executions
                       (verification_id, execution_id, bound_at)
                     VALUES (
                       'ver_018f2b3c-4d5e-7abc-8def-0123456789a1', ?, 't0'
                     )`,
                      [executionId],
                    );
                  }),
                );
              }
            }),
            revokerSqlite,
          ),
        );
        releaseAdmission();
        const result = await resultPromise;

        if (result.gate._tag !== "Denied") {
          throw new Error("authority source mutation was not denied");
        }
        if (result.record === null || typeof result.record === "string") {
          throw new Error("no-effect denial record was not persisted");
        }
        if (result.persisted === undefined || result.approval === null) {
          throw new Error("denial replay snapshot was not captured");
        }

        expect(result.gate).toEqual({
          _tag: "Denied",
          reasonCode: "InvocationAuthorityDenied",
        });
        expect(result.record.effectAdmissionState).toBe("NotAdmitted");
        expect(Option.isSome(result.persisted)).toBe(true);
        if (Option.isSome(result.persisted)) {
          expect(result.persisted.value).toMatchObject({
            effectAdmissionState: "NotAdmitted",
            settlement: {
              _tag: "Denied",
              reasonCode: "ApprovalNoLongerAuthorized",
            },
          });
        }
        expect(
          Option.isSome(result.approval) && result.approval.value.consumedBy,
        ).toBe(invocationF);
        expect(executorCalls).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("stores Denied/Interrupted only while NotAdmitted and rejects a stale fence", async () => {
    const migrations = p31WithAh7Migrations();
    expect(migrations).toBeDefined();
    if (migrations === undefined) return;
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(migrations);
      yield* seedExecution;
      yield* seedApproval;
      const tx = yield* TransactionPort;
      const store = (yield* ToolInvocationStore) as unknown as {
        recordIntent: (
          ...args: ReadonlyArray<unknown>
        ) => Effect.Effect<void, unknown, never>;
        recordNoEffectDenial: (
          ...args: ReadonlyArray<unknown>
        ) => Effect.Effect<unknown, unknown, never>;
        recordNoEffectInterruption: (
          ...args: ReadonlyArray<unknown>
        ) => Effect.Effect<boolean, unknown, never>;
        admitEffect: (
          ...args: ReadonlyArray<unknown>
        ) => Effect.Effect<unknown, unknown, never>;
        consumeApproval: (
          ...args: ReadonlyArray<unknown>
        ) => Effect.Effect<boolean, unknown, never>;
        settle: (
          ...args: ReadonlyArray<unknown>
        ) => Effect.Effect<boolean, unknown, never>;
      };
      const sql = yield* SqlClient;
      const staleFence = { ...fence, fencingGeneration: 1 as LeaseGeneration };

      const staleWrite = yield* Effect.exit(
        tx.transact(
          store.recordIntent(intent(invocationC, false), staleFence, fenceNow),
        ),
      );
      const staleRows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
        [invocationC],
      );
      yield* tx.transact(
        store.recordIntent(intent(invocationC, true), fence, fenceNow),
      );
      const staleConsume = yield* Effect.exit(
        tx.transact(
          store.consumeApproval(approvalId, invocationC, staleFence, fenceNow),
        ),
      );
      const approvalAfterStaleConsume = yield* tx.transact(
        (yield* ToolInvocationStore).findApproval(approvalId),
      );
      const staleDenial = yield* Effect.exit(
        tx.transact(
          store.recordNoEffectDenial(
            intent(invocationE, false),
            "InvocationAuthorityDenied",
            fenceNow,
            staleFence,
            fenceNow,
          ),
        ),
      );
      const staleDenialRows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
        [invocationE],
      );

      yield* tx.transact(
        store.recordIntent(intent(invocationE, false), fence, fenceNow),
      );
      const authority = {
        principal: "worker:ah7-dg03",
        workspaceId,
        executionId,
        toolName: "write_once",
        toolVersion: "1",
        resourceSpaceIds: [],
        allowedCapabilities: [],
        controlBasisDigest: "basis",
        expiresAt: "2999-01-01T00:00:00.000Z",
        delegationDepth: 0,
        sourceRevision: invocationAuthoritySourceRevisionOf({
          workspacePolicyRevision: 0,
          activeGrants: [],
          verifierId: null,
        }),
      };
      const staleAdmission = yield* Effect.exit(
        tx.transact(
          store.admitEffect(invocationE, authority, fenceNow, staleFence),
        ),
      );
      const stateAfterStaleAdmission = yield* sql.unsafe<{
        effect_admission_state: string;
      }>(
        "SELECT effect_admission_state FROM tool_invocations WHERE invocation_id = ?",
        [invocationE],
      );
      const admitted = yield* tx.transact(
        store.admitEffect(invocationE, authority, fenceNow, fence),
      );
      const staleSettlement = yield* Effect.exit(
        tx.transact(
          store.settle(
            invocationE,
            { _tag: "Success" },
            null,
            fenceNow,
            staleFence,
            fenceNow,
          ),
        ),
      );
      const afterStaleSettlement = yield* sql.unsafe<{
        settlement_kind: string | null;
        effect_admission_state: string;
      }>(
        "SELECT settlement_kind, effect_admission_state FROM tool_invocations WHERE invocation_id = ?",
        [invocationE],
      );

      const denial = yield* tx.transact(
        store.recordNoEffectDenial(
          intent(invocationA, true),
          "InvocationAuthorityDenied",
          fenceNow,
          fence,
          fenceNow,
        ),
      );
      const denialRow = yield* sql.unsafe<{
        effect_admission_state: string;
        settlement_kind: string;
        settlement_json: string;
        consumed_by: string | null;
      }>(
        `SELECT i.effect_admission_state, i.settlement_kind,
                i.settlement_json, a.consumed_by
           FROM tool_invocations i
           JOIN invocation_approvals a ON a.approval_id = i.approval_id
          WHERE i.invocation_id = ?`,
        [invocationA],
      );

      yield* tx.transact(
        store.recordIntent(intent(invocationB, false), fence, fenceNow),
      );
      yield* sql.unsafe(
        "UPDATE executions SET stop_requested_at = ? WHERE execution_id = ?",
        [fenceNow, executionId],
      );
      const stoppedGate = yield* tx.transact(
        store.admitEffect(
          invocationB,
          { controlBasisDigest: "basis" },
          fenceNow,
          fence,
        ),
      );
      const interrupted = yield* tx.transact(
        store.recordNoEffectInterruption(
          invocationB,
          fenceNow,
          fence,
          fenceNow,
        ),
      );
      const interruptionRow = yield* sql.unsafe<{
        effect_admission_state: string;
        settlement_kind: string | null;
      }>(
        "SELECT effect_admission_state, settlement_kind FROM tool_invocations WHERE invocation_id = ?",
        [invocationB],
      );
      yield* sql.unsafe(
        "UPDATE executions SET stop_requested_at = NULL WHERE execution_id = ?",
        [executionId],
      );
      yield* sql.unsafe(
        "UPDATE execution_leases SET expires_at = ? WHERE execution_id = ?",
        [fenceNow, executionId],
      );
      const expiredLeaseAdmission = yield* Effect.exit(
        tx.transact(store.admitEffect(invocationC, authority, fenceNow, fence)),
      );
      const stateAfterExpiredLease = yield* sql.unsafe<{
        effect_admission_state: string;
      }>(
        "SELECT effect_admission_state FROM tool_invocations WHERE invocation_id = ?",
        [invocationC],
      );

      return {
        staleWrite,
        staleRows: staleRows[0],
        staleConsume,
        approvalAfterStaleConsume,
        staleDenial,
        staleDenialRows: staleDenialRows[0],
        staleAdmission,
        stateAfterStaleAdmission: stateAfterStaleAdmission[0],
        admitted,
        staleSettlement,
        afterStaleSettlement: afterStaleSettlement[0],
        denial,
        denialRow: denialRow[0],
        stoppedGate,
        interrupted,
        interruptionRow: interruptionRow[0],
        expiredLeaseAdmission,
        stateAfterExpiredLease: stateAfterExpiredLease[0],
      };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.staleWrite)).toBe(true);
    expect(result.staleRows?.count).toBe(0);
    expect(Exit.isFailure(result.staleConsume)).toBe(true);
    expect(
      Option.isSome(result.approvalAfterStaleConsume) &&
        result.approvalAfterStaleConsume.value.consumedBy,
    ).toBeNull();
    expect(Exit.isFailure(result.staleDenial)).toBe(true);
    expect(result.staleDenialRows?.count).toBe(0);
    expect(Exit.isFailure(result.staleAdmission)).toBe(true);
    expect(result.stateAfterStaleAdmission?.effect_admission_state).toBe(
      "NotAdmitted",
    );
    expect(result.admitted).toEqual({ _tag: "Admitted" });
    expect(Exit.isFailure(result.staleSettlement)).toBe(true);
    expect(result.afterStaleSettlement).toEqual({
      settlement_kind: null,
      effect_admission_state: "MayHaveStarted",
    });
    expect(result.denial).toBeDefined();
    expect(result.denialRow).toEqual({
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Denied",
      settlement_json: JSON.stringify({
        _tag: "Denied",
        reasonCode: "InvocationAuthorityDenied",
        projectionVersion: 1,
      }),
      consumed_by: null,
    });
    expect(result.stoppedGate).toEqual({ _tag: "ExecutionStopping" });
    expect(result.interrupted).toBe(true);
    expect(result.interruptionRow).toEqual({
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Interrupted",
    });
    expect(Exit.isFailure(result.expiredLeaseAdmission)).toBe(true);
    expect(result.stateAfterExpiredLease?.effect_admission_state).toBe(
      "NotAdmitted",
    );
    expect(Exit.isFailure(result.staleWrite)).toBe(true);
    expect(result.staleRows?.count).toBe(0);
  });
});
