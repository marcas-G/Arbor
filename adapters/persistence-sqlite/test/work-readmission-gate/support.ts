import { Actor, parse } from "@arbor/domain";
import {
  DomainEventJournal,
  type IdGenerator,
  type RecoveryAttentionFactStore,
  type TerminalProviderFailureKind,
  TransactionPort,
  WorkReadmissionGateStore,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll } from "vitest";
import {
  createCurrentSchemaTestDatabaseFactory,
  type Schema44TestDatabaseFactory,
} from "../../../../tests/support/schema44-database.js";
import {
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeRecoveryAttentionFactStoreLive,
  SandboxProviderUnavailableStoreLive,
  TransactionPortLive,
  WorkReadmissionGateStoreLive,
} from "../../src/index.js";

export const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789c1";
export const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789c1";
export const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c1";
export const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789c1";
export const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789c1";
export const otherWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789c2";
export const otherSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c2";
export const otherWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789c2";
export const otherExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789c2";
export const thirdWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789c4";
export const thirdSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c4";
export const thirdWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789c4";
export const thirdExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789c4";
export const otherProjectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789c2";
export const otherProjectWorkspaceId =
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c3";
export const otherProjectSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c3";
export const otherProjectExecutionId =
  "exe_018f2b3c-4d5e-7abc-8def-0123456789c3";

export const makeApp = (filename: string) => {
  const sqlite = layer({ filename });
  const infra = Layer.mergeAll(sqlite, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const sandboxUnavailableStore = Layer.provide(
    SandboxProviderUnavailableStoreLive,
    Layer.mergeAll(infra, journal),
  );
  return Layer.mergeAll(
    infra,
    journal,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(
      WorkReadmissionGateStoreLive,
      Layer.mergeAll(sqlite, sandboxUnavailableStore),
    ),
    sandboxUnavailableStore,
    Layer.provide(
      makeRecoveryAttentionFactStoreLive(),
      Layer.mergeAll(infra, journal),
    ),
  );
};

export let schema44Factory: Schema44TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema44Factory = await createCurrentSchemaTestDatabaseFactory();
}, 120_000);

afterAll(() => {
  schema44Factory?.cleanup();
  schema44Factory = undefined;
}, 120_000);

export const runDb = <A>(
  program: Effect.Effect<
    A,
    unknown,
    | SqlClient
    | TransactionPort
    | WorkReadmissionGateStore
    | RecoveryAttentionFactStore
    | DomainEventJournal
    | IdGenerator
  >,
) => {
  const run = async () => {
    if (schema44Factory === undefined) {
      throw new Error("The schema-42 test database factory is not ready.");
    }
    const database = schema44Factory.create();
    try {
      return await Effect.runPromise(
        Effect.scoped(
          Effect.provide(program, makeApp(database.databaseFilename)),
        ),
      );
    } finally {
      database.cleanup();
    }
  };
  return run();
};

export const seed = (
  settlement: unknown = null,
  stopRequestedAtOverride?: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
    const settlementResult =
      typeof settlement === "object" && settlement !== null
        ? (settlement as { readonly result?: { readonly _tag?: string } })
            .result
        : undefined;
    const stopRequestedAt =
      stopRequestedAtOverride === undefined
        ? settlementResult?._tag === "StopRequested"
          ? "t0"
          : null
        : stopRequestedAtOverride;
    yield* tx.transact(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `INSERT INTO projects (
            project_id, name, root_workspace_id, project_policy,
            project_policy_revision, default_configuration, environment_ref,
            lifecycle, revision, created_at, updated_at
          ) VALUES (?, 'readmission test', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
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
          ) VALUES (?, ?, NULL, 'Root', '{}', 0, '{}', 0, '{}', ?, ?, '{}', 0, 0, 'Active', 't0', 't0')`,
          [workspaceId, projectId, sessionId, workId],
        );
        yield* sql.unsafe(
          `INSERT INTO works (
            work_id, project_id, workspace_id, objective, why, constraints,
            completion_expectation, verification_mission, provenance,
            lifecycle, revision, created_at, updated_at
          ) VALUES (?, ?, ?, 'objective', 'why', '[]', 'done', '{}', '{}', 'Open', 0, 't0', 't0')`,
          [workId, projectId, workspaceId],
        );
        yield* sql.unsafe(
          `INSERT INTO executions (
            execution_id, project_id, binding_kind, workspace_id,
            episode_kind, episode_ref, episode_revision, parent_execution_id,
            mission, session_id, admitted_at, stop_requested_at,
            settlement_kind, settlement_json, settled_at
          ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 0,
            NULL, NULL, ?, 't0', ?, ?, ?, ?)`,
          [
            executionId,
            projectId,
            workspaceId,
            workId,
            sessionId,
            stopRequestedAt,
            settlement === null
              ? null
              : (settlement as { readonly _tag: string })._tag,
            settlement === null ? null : JSON.stringify(settlement),
            settlement === null ? null : "t1",
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO agent_execution_state (
            execution_id, episode_json, wake_reason, current_mode,
            active_skill_refs_json, turn_no, recent_directive_refs_json,
            recent_action_fingerprints_json, updated_at
          ) VALUES (?, ?, 'Initial', NULL, '[]', 0, '[]', '[]', 't0')`,
          [
            executionId,
            JSON.stringify({
              _tag: "WorkEpisode",
              workId,
              targetWorkRevision: 0,
            }),
          ],
        );
      }),
    );
  });

export const terminalSettlement = (kind: string) => ({
  _tag: "Failed" as const,
  failure: {
    _tag: "ExecutionFailure" as const,
    reason: `ProviderFailure:${kind}`,
  },
});

export const seedTerminalProviderFailureChain = (
  kind: TerminalProviderFailureKind = "RequestRejected",
  options: {
    readonly omitStep?: boolean;
    readonly taxonomy?: string;
    readonly retryDecision?: string;
    readonly occurrenceTime?: string;
    readonly attemptOutcome?: string;
    readonly providerErrorKind?: string | null;
    readonly turnFinishReason?: string;
    readonly malformedManifest?: boolean;
    readonly additionalSettlementStep?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
    const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789c1";
    const manifestId = "mft_terminal_provider_failure";
    const settlementJson = JSON.stringify(terminalSettlement(kind));
    yield* tx.transact(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `INSERT INTO provider_turns (
            provider_turn_id, execution_id, session_id, context_epoch,
            model_ref, output_contract_ref, manifest_id, started_at,
            settled_at, finish_reason, usage_json, created_at,
            execution_policy_json, turn_deadline_at
          ) VALUES (?, ?, ?, 0, 'model-a', 'agent-action-v1', ?, ?, ?,
                    ?, '{}', ?, NULL, NULL)`,
          [
            providerTurnId,
            executionId,
            sessionId,
            manifestId,
            "2026-10-25T00:00:00.000Z",
            "2026-10-25T00:00:02.000Z",
            options.turnFinishReason ?? "Failed",
            "2026-10-25T00:00:00.000Z",
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO model_context_manifests (
            manifest_id, provider_turn_id, execution_id, session_id,
            context_epoch, model_ref, compiled_request_hash, manifest_json,
            created_at, portable_request_json
          ) VALUES (?, ?, ?, ?, 0, 'model-a', ?, ?, ?, NULL)`,
          [
            manifestId,
            providerTurnId,
            executionId,
            sessionId,
            "b".repeat(64),
            JSON.stringify({
              providerTurnId,
              executionId,
              sessionId,
              logicalStepNo: 0,
              repairAttempt: 0,
              compiledRequestHash: "b".repeat(64),
              outputContractRef: options.malformedManifest
                ? "different-contract"
                : "agent-action-v1",
              resolvedModelBindingFingerprint: `p16fp_${"a".repeat(64)}`,
            }),
            "2026-10-25T00:00:00.000Z",
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO provider_attempts (
            provider_turn_id, attempt_no, started_at, settled_at, outcome,
            provider_error_kind, failure_taxonomy_version, retry_safety,
            retry_decision, retry_reason
          ) VALUES (?, 0, ?, ?, ?, ?, ?, 'UnsafeReplay', ?,
                    'terminal provider failure')`,
          [
            providerTurnId,
            "2026-10-25T00:00:00.000Z",
            options.occurrenceTime ?? "2026-10-25T00:00:01.000Z",
            options.attemptOutcome ?? "TerminalFailure",
            options.providerErrorKind === undefined
              ? kind
              : options.providerErrorKind,
            options.taxonomy ?? "phase1-v2",
            options.retryDecision ?? "Stop",
          ],
        );
        if (options.omitStep !== true) {
          yield* sql.unsafe(
            `INSERT INTO agent_loop_steps (
              execution_id, logical_step_no, repair_attempt, provider_turn_id,
              manifest_id, state, next_action_index, settlement_json, revision,
              updated_at
            ) VALUES (?, 0, 0, ?, ?, 'SettlementProposed', 0, ?, 0, ?)`,
            [
              executionId,
              providerTurnId,
              manifestId,
              settlementJson,
              "2026-10-25T00:00:02.000Z",
            ],
          );
          if (options.additionalSettlementStep === true) {
            yield* sql.unsafe(
              `INSERT INTO agent_loop_steps (
                execution_id, logical_step_no, repair_attempt, provider_turn_id,
                manifest_id, state, next_action_index, settlement_json, revision,
                updated_at
              ) VALUES (?, 1, 0, ?, ?, 'SettlementProposed', 0, ?, 0, ?)`,
              [
                executionId,
                "ptn_018f2b3c-4d5e-7abc-8def-0123456789c2",
                manifestId,
                settlementJson,
                "2026-10-25T00:00:02.000Z",
              ],
            );
          }
        }
      }),
    );
  });

export const seedTerminalFailureHistory = (
  count: number,
  malformedIndex?: number,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
    yield* tx.transact(
      Effect.gen(function* () {
        for (let index = count - 1; index >= 0; index -= 1) {
          const suffix = index.toString(16).padStart(12, "0");
          const historyExecutionId = `exe_00000000-0000-4000-8000-${suffix}`;
          const providerTurnId = `ptn_00000000-0000-4000-8000-${suffix}`;
          const manifestId = `mft_00000000-0000-4000-8000-${suffix}`;
          const admittedAt = new Date(
            Date.UTC(2026, 9, 25, 0, 0, index),
          ).toISOString();
          const attemptSettledAt = new Date(
            Date.parse(admittedAt) + 1_000,
          ).toISOString();
          const executionSettledAt = new Date(
            Date.parse(admittedAt) + 2_000,
          ).toISOString();
          const settlement = terminalSettlement("RequestRejected");
          const settlementJson = JSON.stringify(settlement);
          const compiledRequestHash = "b".repeat(64);
          const outputContractRef =
            index === malformedIndex
              ? "conflicting-contract"
              : "agent-action-v1";

          yield* sql.unsafe(
            `INSERT INTO executions (
              execution_id, project_id, binding_kind, workspace_id,
              episode_kind, episode_ref, episode_revision, parent_execution_id,
              mission, session_id, admitted_at, stop_requested_at,
              settlement_kind, settlement_json, settled_at
            ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 0,
                      NULL, NULL, ?, ?, NULL, 'Failed', ?, ?)`,
            [
              historyExecutionId,
              projectId,
              workspaceId,
              workId,
              sessionId,
              admittedAt,
              settlementJson,
              executionSettledAt,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO agent_execution_state (
              execution_id, episode_json, wake_reason, current_mode,
              active_skill_refs_json, turn_no, recent_directive_refs_json,
              recent_action_fingerprints_json, updated_at
            ) VALUES (?, ?, 'Initial', NULL, '[]', 0, '[]', '[]', ?)`,
            [
              historyExecutionId,
              JSON.stringify({
                _tag: "WorkEpisode",
                workId,
                targetWorkRevision: 0,
              }),
              admittedAt,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO provider_turns (
              provider_turn_id, execution_id, session_id, context_epoch,
              model_ref, output_contract_ref, manifest_id, started_at,
              settled_at, finish_reason, usage_json, created_at,
              execution_policy_json, turn_deadline_at
            ) VALUES (?, ?, ?, 0, 'model-a', ?, ?, ?, ?, 'Failed', '{}', ?, NULL, NULL)`,
            [
              providerTurnId,
              historyExecutionId,
              sessionId,
              "agent-action-v1",
              manifestId,
              admittedAt,
              executionSettledAt,
              admittedAt,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO model_context_manifests (
              manifest_id, provider_turn_id, execution_id, session_id,
              context_epoch, model_ref, compiled_request_hash, manifest_json,
              created_at, portable_request_json
            ) VALUES (?, ?, ?, ?, 0, 'model-a', ?, ?, ?, NULL)`,
            [
              manifestId,
              providerTurnId,
              historyExecutionId,
              sessionId,
              compiledRequestHash,
              JSON.stringify({
                providerTurnId,
                executionId: historyExecutionId,
                sessionId,
                logicalStepNo: 0,
                repairAttempt: 0,
                compiledRequestHash,
                outputContractRef,
                resolvedModelBindingFingerprint: `p16fp_${"a".repeat(64)}`,
              }),
              admittedAt,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO provider_attempts (
              provider_turn_id, attempt_no, started_at, settled_at, outcome,
              provider_error_kind, failure_taxonomy_version, retry_safety,
              retry_decision, retry_reason
            ) VALUES (?, 0, ?, ?, 'TerminalFailure', 'RequestRejected',
                      'phase1-v2', 'UnsafeReplay', 'Stop', 'terminal failure')`,
            [providerTurnId, admittedAt, attemptSettledAt],
          );
          yield* sql.unsafe(
            `INSERT INTO agent_loop_steps (
              execution_id, logical_step_no, repair_attempt, provider_turn_id,
              manifest_id, state, next_action_index, settlement_json, revision,
              updated_at
            ) VALUES (?, 0, 0, ?, ?, 'SettlementProposed', 0, ?, 0, ?)`,
            [
              historyExecutionId,
              providerTurnId,
              manifestId,
              settlementJson,
              executionSettledAt,
            ],
          );
        }
      }),
    );
  });

export const terminalFailureHistorySnapshot = (sql: SqlClient) =>
  Effect.gen(function* () {
    const executions = yield* sql.unsafe(
      `SELECT execution_id, project_id, workspace_id, episode_kind,
              episode_ref, episode_revision, admitted_at, settlement_kind,
              settlement_json, settled_at
         FROM executions WHERE episode_ref = ? ORDER BY execution_id`,
      [workId],
    );
    const states = yield* sql.unsafe(
      `SELECT execution_id, episode_json, updated_at
         FROM agent_execution_state
        WHERE execution_id IN (
          SELECT execution_id FROM executions WHERE episode_ref = ?
        ) ORDER BY execution_id`,
      [workId],
    );
    const steps = yield* sql.unsafe(
      `SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id,
              manifest_id, state, settlement_json
         FROM agent_loop_steps
        WHERE execution_id IN (
          SELECT execution_id FROM executions WHERE episode_ref = ?
        ) ORDER BY execution_id, logical_step_no, repair_attempt`,
      [workId],
    );
    const turns = yield* sql.unsafe(
      `SELECT provider_turn_id, execution_id, session_id, manifest_id,
              settled_at, finish_reason
         FROM provider_turns
        WHERE execution_id IN (
          SELECT execution_id FROM executions WHERE episode_ref = ?
        ) ORDER BY provider_turn_id`,
      [workId],
    );
    const manifests = yield* sql.unsafe(
      `SELECT manifest_id, provider_turn_id, execution_id, manifest_json
         FROM model_context_manifests
        WHERE execution_id IN (
          SELECT execution_id FROM executions WHERE episode_ref = ?
        ) ORDER BY manifest_id`,
      [workId],
    );
    const attempts = yield* sql.unsafe(
      `SELECT provider_turn_id, attempt_no, settled_at, outcome,
              provider_error_kind, failure_taxonomy_version, retry_decision
         FROM provider_attempts
        WHERE provider_turn_id IN (
          SELECT provider_turn_id FROM provider_turns
           WHERE execution_id IN (
             SELECT execution_id FROM executions WHERE episode_ref = ?
           )
        ) ORDER BY provider_turn_id, attempt_no`,
      [workId],
    );
    return { executions, states, steps, turns, manifests, attempts };
  });

export const seedOtherWorkspaceExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [otherSessionId, otherWorkspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, ?, 'Other', '{}', 0, '{}', 0, '{}', ?, ?, '{}', 0, 0, 'Active', 't0', 't0')`,
        [otherWorkspaceId, projectId, workspaceId, otherSessionId, otherWorkId],
      );
      yield* sql.unsafe(
        `INSERT INTO works (
          work_id, project_id, workspace_id, objective, why, constraints,
          completion_expectation, verification_mission, provenance,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'other objective', 'why', '[]', 'done', '{}', '{}', 'Open', 0, 't0', 't0')`,
        [otherWorkId, projectId, otherWorkspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 0,
          NULL, NULL, ?, 't0', NULL, NULL, NULL, NULL)`,
        [
          otherExecutionId,
          projectId,
          otherWorkspaceId,
          otherWorkId,
          otherSessionId,
        ],
      );
      yield* sql.unsafe(
        `INSERT INTO agent_execution_state (
          execution_id, episode_json, wake_reason, current_mode,
          active_skill_refs_json, turn_no, recent_directive_refs_json,
          recent_action_fingerprints_json, updated_at
        ) VALUES (?, ?, 'Initial', NULL, '[]', 0, '[]', '[]', 't0')`,
        [
          otherExecutionId,
          JSON.stringify({
            _tag: "WorkEpisode",
            workId: otherWorkId,
            targetWorkRevision: 0,
          }),
        ],
      );
    }),
  );
});

export const seedThirdWorkspaceExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [thirdSessionId, thirdWorkspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, ?, 'Third', '{}', 0, '{}', 0, '{}', ?, ?, '{}', 0, 0, 'Active', 't0', 't0')`,
        [thirdWorkspaceId, projectId, workspaceId, thirdSessionId, thirdWorkId],
      );
      yield* sql.unsafe(
        `INSERT INTO works (
          work_id, project_id, workspace_id, objective, why, constraints,
          completion_expectation, verification_mission, provenance,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'third objective', 'why', '[]', 'done', '{}', '{}', 'Open', 0, 't0', 't0')`,
        [thirdWorkId, projectId, thirdWorkspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 0,
          NULL, NULL, ?, 't0', NULL, NULL, NULL, NULL)`,
        [
          thirdExecutionId,
          projectId,
          thirdWorkspaceId,
          thirdWorkId,
          thirdSessionId,
        ],
      );
      yield* sql.unsafe(
        `INSERT INTO agent_execution_state (
          execution_id, episode_json, wake_reason, current_mode,
          active_skill_refs_json, turn_no, recent_directive_refs_json,
          recent_action_fingerprints_json, updated_at
        ) VALUES (?, ?, 'Initial', NULL, '[]', 0, '[]', '[]', 't0')`,
        [
          thirdExecutionId,
          JSON.stringify({
            _tag: "WorkEpisode",
            workId: thirdWorkId,
            targetWorkRevision: 0,
          }),
        ],
      );
    }),
  );
});

export const seedOtherProjectExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'other project', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
        [otherProjectId, otherProjectWorkspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [otherProjectSessionId, otherProjectWorkspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'Other Project', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
        [otherProjectWorkspaceId, otherProjectId, otherProjectSessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', 'wrk_other_project', 0,
          NULL, NULL, ?, 't0', NULL, NULL, NULL, NULL)`,
        [
          otherProjectExecutionId,
          otherProjectId,
          otherProjectWorkspaceId,
          otherProjectSessionId,
        ],
      );
      yield* sql.unsafe(
        `INSERT INTO agent_execution_state (
          execution_id, episode_json, wake_reason, current_mode,
          active_skill_refs_json, turn_no, recent_directive_refs_json,
          recent_action_fingerprints_json, updated_at
        ) VALUES (?, ?, 'Initial', NULL, '[]', 0, '[]', '[]', 't0')`,
        [
          otherProjectExecutionId,
          JSON.stringify({
            _tag: "WorkEpisode",
            workId: "wrk_other_project",
            targetWorkRevision: 0,
          }),
        ],
      );
    }),
  );
});

export const appendReconciliationEvent = (
  aggregateRef: string,
  payloadExecutionId?: string,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    const payload = {
      ...(payloadExecutionId === undefined
        ? {}
        : { executionId: payloadExecutionId }),
      invocationRefsFingerprint: "invocation-fingerprint",
      refs: ["invocation-ref"],
    };
    yield* tx.transact(
      journal.append([
        {
          projectId: projectId as never,
          eventType: "ReconciliationEscalated",
          eventVersion: 1,
          occurredAt: "t1",
          aggregateRef,
          actor: parse(Actor)("system:recovery"),
          payload,
        },
      ]),
    );
  });

export const appendMalformedReconciliationEvent = (aggregateRef: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
    yield* tx.transact(
      sql.unsafe(
        `INSERT INTO domain_events (
          event_id, project_id, sequence, event_type, event_version,
          occurred_at, aggregate_ref, actor, caused_by_command_id,
          caused_by_event_id, correlation_ref, payload_json
        ) VALUES ('evt_readmission_malformed', ?, 1, 'ReconciliationEscalated',
          1, 't1', ?, 'system:recovery', NULL, NULL, NULL, '{broken-json')`,
        [projectId, aggregateRef],
      ),
    );
  });

export const query = (workRevision = 0) =>
  queryTarget(projectId, workspaceId, workId, workRevision);

export const queryTarget = (
  requestedProjectId: string,
  requestedWorkspaceId: string,
  requestedWorkId: string,
  workRevision = 0,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const gate = yield* WorkReadmissionGateStore;
    return yield* tx.transact(
      gate.hasBlockingSource({
        projectId: requestedProjectId as never,
        workspaceId: requestedWorkspaceId as never,
        workId: requestedWorkId as never,
        workRevision: workRevision as never,
      }),
    );
  });
