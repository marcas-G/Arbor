import { Actor, parse } from "@arbor/domain";
import {
  type AssignWorkBindingFailureCode,
  type DeliverReplayFailureCode,
  DomainEventJournal,
  type IdGenerator,
  RecoveryAttentionFactStore,
  TransactionPort,
  WorkReadmissionGateStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCurrentSchemaTestDatabaseFactory,
  type Schema44TestDatabaseFactory,
} from "../../../tests/support/schema44-database.js";
import {
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeRecoveryAttentionFactStoreLive,
  TransactionPortLive,
  WorkReadmissionGateStoreLive,
} from "../src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789c1";
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789c1";
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c1";
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789c1";
const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789c1";
const otherWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789c2";
const otherSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c2";
const otherWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789c2";
const otherExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789c2";
const thirdWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789c4";
const thirdSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c4";
const thirdWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789c4";
const thirdExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789c4";
const otherProjectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789c2";
const otherProjectWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789c3";
const otherProjectSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c3";
const otherProjectExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789c3";

const makeApp = (filename: string) => {
  const sqlite = layer({ filename });
  const infra = Layer.mergeAll(sqlite, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  return Layer.mergeAll(
    infra,
    journal,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(WorkReadmissionGateStoreLive, sqlite),
    Layer.provide(
      makeRecoveryAttentionFactStoreLive(),
      Layer.mergeAll(infra, journal),
    ),
  );
};

let schema44Factory: Schema44TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema44Factory = await createCurrentSchemaTestDatabaseFactory();
}, 120_000);

afterAll(() => {
  schema44Factory?.cleanup();
  schema44Factory = undefined;
}, 120_000);

const runDb = <A>(
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

const seed = (
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

const terminalSettlement = (kind: string) => ({
  _tag: "Failed" as const,
  failure: {
    _tag: "ExecutionFailure" as const,
    reason: `ProviderFailure:${kind}`,
  },
});

const seedTerminalProviderFailureChain = (
  kind:
    | "AuthenticationFailed"
    | "RequestRejected"
    | "ProtocolViolation" = "RequestRejected",
  options: {
    readonly omitStep?: boolean;
    readonly taxonomy?: string;
    readonly retryDecision?: string;
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
                    'Failed', '{}', ?, NULL, NULL)`,
          [
            providerTurnId,
            executionId,
            sessionId,
            manifestId,
            "2026-10-25T00:00:00.000Z",
            "2026-10-25T00:00:02.000Z",
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
              outputContractRef: "agent-action-v1",
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
          ) VALUES (?, 0, ?, ?, 'TerminalFailure', ?, ?, 'UnsafeReplay', ?,
                    'terminal provider failure')`,
          [
            providerTurnId,
            "2026-10-25T00:00:00.000Z",
            "2026-10-25T00:00:01.000Z",
            kind,
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
        }
      }),
    );
  });

const seedOtherWorkspaceExecution = Effect.gen(function* () {
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

const seedThirdWorkspaceExecution = Effect.gen(function* () {
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

const seedOtherProjectExecution = Effect.gen(function* () {
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

const appendReconciliationEvent = (
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

const appendMalformedReconciliationEvent = (aggregateRef: string) =>
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

const query = (workRevision = 0) =>
  queryTarget(projectId, workspaceId, workId, workRevision);

const queryTarget = (
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

describe("P2 WorkReadmissionGateStore", () => {
  it("maps SQLite query failures to the shared semantic persistence error", () =>
    runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe("DROP TABLE works");
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const encoded = JSON.stringify(exit.cause);
          expect(encoded).toContain('"_tag":"PersistenceUnavailable"');
          expect(encoded).toContain('"repository":"WorkReadmissionGateStore"');
          expect(encoded).not.toContain("ReadmissionGateStoreFailure");
        }
      }),
    ));

  it("reads a durable RuntimeSafetyStop hold for the exact Work revision and releases only after revision advance", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({
          _tag: "Interrupted",
          result: {
            _tag: "ControlledInterruption",
            reason: "RuntimeSafetyStop",
          },
        });
        const held = yield* query();
        expect(Option.isSome(held) && held.value).toEqual({
          sourceKind: "RuntimeSafetyStopSettlement",
          executionId,
        });

        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe("UPDATE works SET revision = 1 WHERE work_id = ?", [
            workId,
          ]),
        );
        const afterSteer = yield* query(1);
        expect(Option.isNone(afterSteer)).toBe(true);
      }),
    ));

  it("derives a hold from the P9 fact and its exact event witness without waiting for settlement", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        const fact = yield* tx.transact(
          facts.recordDeliverReplayFailure({
            projectId: projectId as never,
            executionId: executionId as never,
            targetWorkspaceId: workspaceId as never,
            logicalActionId: "act_readmission_deliver",
            messageId: "msg_readmission_deliver",
            failureCode: "LegacyMessageMissingEvent",
            firstDetectedAt: "t1",
          }),
        );
        const result = yield* query();
        expect(Option.isSome(result) && result.value).toEqual({
          sourceKind: "DeliverReplayFact",
          executionId,
        });
        const sql = yield* SqlClient;
        yield* tx.transact(
          sql.unsafe("DELETE FROM domain_events WHERE event_id = ?", [
            fact.eventId,
          ]),
        );
        const retainedFact = yield* query();
        expect(Option.isSome(retainedFact) && retainedFact.value).toEqual({
          sourceKind: "DeliverReplayFact",
          executionId,
        });
        yield* tx.transact(
          sql.unsafe(
            "DELETE FROM agent_execution_state WHERE execution_id = ?",
            [executionId],
          ),
        );
        const missingEpisode = yield* Effect.exit(query());
        expect(missingEpisode._tag).toBe("Failure");
        if (missingEpisode._tag === "Failure") {
          expect(JSON.stringify(missingEpisode.cause)).toContain(
            '"reasonCode":"SourceEpisodeStateMissing"',
          );
        }
      }),
    ));

  it("fails closed when a retained DeliverReplayFact has a present conflicting event witness", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        const fact = yield* tx.transact(
          facts.recordDeliverReplayFailure({
            projectId: projectId as never,
            executionId: executionId as never,
            targetWorkspaceId: workspaceId as never,
            logicalActionId: "act_readmission_deliver_mismatch",
            messageId: "msg_readmission_deliver_mismatch",
            failureCode: "LegacyMessageMissingEvent",
            firstDetectedAt: "t1",
          }),
        );
        const sql = yield* SqlClient;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE domain_events SET payload_json = '{}' WHERE event_id = ?",
            [fact.eventId],
          ),
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceFactEventMismatch"',
          );
        }
      }),
    ));

  it("fails closed on malformed durable episode binding with bounded integrity details", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({
          _tag: "Interrupted",
          result: {
            _tag: "ControlledInterruption",
            reason: "RuntimeSafetyStop",
          },
        });
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE agent_execution_state SET episode_json = ? WHERE execution_id = ?",
            ["not-json", executionId],
          ),
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const encoded = JSON.stringify(exit.cause);
          expect(encoded).toContain('"_tag":"ReadmissionGateIntegrityFailure"');
          expect(encoded).toContain(`"executionId":"${executionId}"`);
          expect(encoded).toContain('"reasonCode":"EpisodeMalformed"');
          expect(encoded).not.toContain("not-json");
        }
      }),
    ));

  it("holds exact Work on the canonical OutcomeUnknown reconciliation settlement", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({
          _tag: "OutcomeUnknown",
          reconciliation: {
            _tag: "ReconciliationRequired",
            invocationRefs: ["invocation-ref"],
          },
        });
        const held = yield* query();
        expect(Option.isSome(held) && held.value).toEqual({
          sourceKind: "OutcomeUnknownSettlement",
          executionId,
        });
      }),
    ));

  it.each([
    null,
    { _tag: "UnexpectedInterruption" },
    { _tag: "ControlledInterruption", reason: 42 },
  ])("fails closed for malformed Interrupted settlement result %j", (result) =>
    runDb(
      Effect.gen(function* () {
        yield* seed({ _tag: "Interrupted", result });
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SettlementMalformed"',
          );
        }
      }),
    ),
  );

  it("keeps StopRequested settlement outside the gate even without Episode state", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({ _tag: "Interrupted", result: { _tag: "StopRequested" } });
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "DELETE FROM agent_execution_state WHERE execution_id = ?",
            [executionId],
          ),
        );
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it("fails closed when StopRequested settlement has no stop request fact", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(
          { _tag: "Interrupted", result: { _tag: "StopRequested" } },
          null,
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SettlementMalformed"',
          );
        }
      }),
    ));

  it("fails closed when a RuntimeSafetyStop source has no Episode state", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({
          _tag: "Interrupted",
          result: {
            _tag: "ControlledInterruption",
            reason: "RuntimeSafetyStop",
          },
        });
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "DELETE FROM agent_execution_state WHERE execution_id = ?",
            [executionId],
          ),
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceEpisodeStateMissing"',
          );
        }
      }),
    ));

  it("fails closed when ReconciliationEscalated aggregate and payload bind different Executions", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(executionId, otherExecutionId);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
          expect(JSON.stringify(exit.cause)).toContain(
            `"executionId":"${executionId}"`,
          );
        }
      }),
    ));

  it("does not let a B/C mismatch block A, while each referenced Workspace fails closed", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* seedThirdWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId, thirdExecutionId);
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        const inC = yield* Effect.exit(
          queryTarget(projectId, thirdWorkspaceId, thirdWorkId),
        );
        expect(inB._tag).toBe("Failure");
        expect(inC._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
        if (inC._tag === "Failure") {
          expect(JSON.stringify(inC.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it("fails closed when a ReconciliationEscalated payload binds this Workspace but aggregate_ref points elsewhere", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId, executionId);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
          expect(JSON.stringify(exit.cause)).toContain(
            `"executionId":"${executionId}"`,
          );
        }
      }),
    ));

  it("fails closed when ReconciliationEscalated payload points to a missing Execution", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* appendReconciliationEvent(
          executionId,
          "exe_018f2b3c-4d5e-7abc-8def-0123456789ff",
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceExecutionMissing"',
          );
        }
      }),
    ));

  it("lets unrelated A skip aggregate B with a missing payload identity, while B rejects it", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId);
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        expect(inB._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it("lets unrelated A skip aggregate B with a foreign-project payload, while B rejects it", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* seedOtherProjectExecution;
        yield* appendReconciliationEvent(
          otherExecutionId,
          otherProjectExecutionId,
        );
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        expect(inB._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceProjectMismatch"',
          );
        }
      }),
    ));

  it("fails closed when both ReconciliationEscalated identities match but the Execution is missing", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const missingExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789fe";
        yield* appendReconciliationEvent(
          missingExecutionId,
          missingExecutionId,
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceExecutionMissing"',
          );
          expect(JSON.stringify(exit.cause)).toContain(
            `"executionId":"${missingExecutionId}"`,
          );
        }
      }),
    ));

  it("fails closed when aggregate Execution is missing but payload binds the requested Workspace", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const missingExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789fd";
        yield* appendReconciliationEvent(missingExecutionId, executionId);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceExecutionMissing"',
          );
        }
      }),
    ));

  it("fails closed when both ReconciliationEscalated identities match an Execution in another Project", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherProjectExecution;
        yield* appendReconciliationEvent(
          otherProjectExecutionId,
          otherProjectExecutionId,
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceProjectMismatch"',
          );
        }
      }),
    ));

  it("fails closed for A and B when aggregate is missing even if payload points to B", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        const missingExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789fc";
        yield* appendReconciliationEvent(missingExecutionId, otherExecutionId);
        const inA = yield* Effect.exit(
          queryTarget(projectId, workspaceId, workId),
        );
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        for (const exit of [inA, inB]) {
          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain(
              '"reasonCode":"SourceExecutionMissing"',
            );
          }
        }
      }),
    ));

  it("fails closed for A and B when aggregate belongs to another Project even if payload points to B", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* seedOtherProjectExecution;
        yield* appendReconciliationEvent(
          otherProjectExecutionId,
          otherExecutionId,
        );
        const inA = yield* Effect.exit(
          queryTarget(projectId, workspaceId, workId),
        );
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        for (const exit of [inA, inB]) {
          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain(
              '"reasonCode":"SourceProjectMismatch"',
            );
          }
        }
      }),
    ));

  it("fails closed when an in-scope ReconciliationEscalated event omits its Execution binding", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* appendReconciliationEvent(executionId);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it("ignores a valid ReconciliationEscalated event whose exact Execution belongs to another Workspace", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId, otherExecutionId);
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it("scopes a missing ReconciliationEscalated payload identity to its aggregate Workspace", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId);
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        expect(inB._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it("scopes an unparseable ReconciliationEscalated payload by aggregate Execution", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendMalformedReconciliationEvent(otherExecutionId);
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        expect(inB._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it.each([
    "AuthenticationFailed",
    "RequestRejected",
    "ProtocolViolation",
  ] as const)(
    "derives the complete %s Provider failure source from the exact durable chain",
    (kind) =>
      runDb(
        Effect.gen(function* () {
          const settlement = terminalSettlement(kind);
          yield* seed(settlement);
          yield* seedTerminalProviderFailureChain(kind);
          const found = yield* query();
          expect(Option.isSome(found)).toBe(true);
          if (Option.isSome(found)) {
            expect(found.value).toMatchObject({
              sourceKind: "TerminalProviderFailureSettlement",
              executionId,
              logicalStepNo: 0,
              repairAttempt: 0,
              attemptNo: 0,
              failureKind: kind,
            });
            expect(
              "failureFingerprint" in found.value
                ? found.value.failureFingerprint
                : "",
            ).toMatch(/^[0-9a-f]{64}$/u);
          }
        }),
      ),
  );

  it("fails closed when the settlement-producing Step is missing", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("ProtocolViolation"));
        yield* seedTerminalProviderFailureChain("ProtocolViolation", {
          omitStep: true,
        });
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceSettlementStepMissing"',
          );
        }
      }),
    ));

  it.each(["RateLimited", "ProviderUnavailable", "StreamInterrupted"] as const)(
    "does not hold retryable %s failures even when the Execution failed",
    (kind) =>
      runDb(
        Effect.gen(function* () {
          yield* seed(terminalSettlement(kind));
          expect(Option.isNone(yield* query())).toBe(true);
        }),
      ),
  );

  it("recognizes every closed DeliverReplay and AssignWork binding failure code", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        const committedCommandId = "cmd_readmission_inventory";
        yield* tx.transact(
          sql.unsafe(
            `INSERT INTO commands (
              command_id, project_id, semantic_request_fingerprint,
              schema_version, fingerprint_algorithm_version, resolution,
              result_json, terminal_error_json, created_at, settled_at
            ) VALUES (?, ?, 'fingerprint', '1', 1, 'Committed', '{}', NULL, 't0', 't0')`,
            [committedCommandId, projectId],
          ),
        );
        const deliverCodes = [
          "LegacyMessageMissingEvent",
          "LegacyEventMissingMessage",
          "LegacyMessageBindingMismatch",
          "LegacyInboxConflict",
          "PriorReceiptDecodeMismatch",
          "PriorReceiptResultMismatch",
          "RejectedReceiptEffectConflict",
          "PriorReceiptEffectConflict",
        ] as const satisfies ReadonlyArray<DeliverReplayFailureCode>;
        const assignCodes = [
          "LegacyUnbound",
          "MissingBinding",
          "DuplicateBinding",
          "MalformedBinding",
          "RefMismatch",
          "AuthorityMismatch",
          "ForeignTarget",
          "PlacementMismatch",
          "SourceActionMismatch",
          "ReceiptMismatch",
          "WorkMismatch",
          "ProvenanceMismatch",
          "EventMismatch",
          "CommitLifecycleMismatch",
        ] as const satisfies ReadonlyArray<AssignWorkBindingFailureCode>;
        yield* tx.transact(
          Effect.gen(function* () {
            for (const [index, failureCode] of deliverCodes.entries()) {
              yield* facts.recordDeliverReplayFailure({
                projectId: projectId as never,
                executionId: executionId as never,
                targetWorkspaceId: workspaceId as never,
                logicalActionId: `act_deliver_inventory_${index}`,
                messageId: `msg_deliver_inventory_${index}`,
                failureCode,
                firstDetectedAt: `t${index + 1}`,
              });
            }
            for (const [index, failureCode] of assignCodes.entries()) {
              yield* facts.recordAssignWorkBindingFailure({
                projectId: projectId as never,
                executionId: executionId as never,
                targetWorkspaceId: workspaceId as never,
                logicalActionId: `act_assign_inventory_${index}`,
                committedCommandId: committedCommandId as never,
                failureCode,
                firstDetectedAt: `t${index + 20}`,
              });
            }
          }),
        );
        expect(Option.isSome(yield* query())).toBe(true);
      }),
    ));
});
