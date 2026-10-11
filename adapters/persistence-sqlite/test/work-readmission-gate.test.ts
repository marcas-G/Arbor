import {
  type DomainEventJournal,
  RecoveryAttentionFactStore,
  TransactionPort,
  WorkReadmissionGateStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeRecoveryAttentionFactStoreLive,
  runMigrations,
  TransactionPortLive,
  WorkReadmissionGateStoreLive,
} from "../src/index.js";
import { CURRENT_MIGRATIONS } from "../src/migrations.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789c1";
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789c1";
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789c1";
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789c1";
const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789c1";

const makeApp = () => {
  const sqlite = layer({ filename: ":memory:" });
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

const runDb = <A>(
  program: Effect.Effect<
    A,
    unknown,
    | SqlClient
    | TransactionPort
    | WorkReadmissionGateStore
    | RecoveryAttentionFactStore
    | DomainEventJournal
  >,
) => Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

const seed = (settlement: unknown = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
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
            NULL, NULL, ?, 't0', NULL, ?, ?, ?)`,
          [
            executionId,
            projectId,
            workspaceId,
            workId,
            sessionId,
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

const query = (workRevision = 0) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const gate = yield* WorkReadmissionGateStore;
    return yield* tx.transact(
      gate.hasBlockingSource({
        projectId: projectId as never,
        workspaceId: workspaceId as never,
        workId: workId as never,
        workRevision: workRevision as never,
      }),
    );
  });

describe("P2 WorkReadmissionGateStore", () => {
  it("reads a durable RuntimeSafetyStop hold for the exact Work revision and releases only after revision advance", () =>
    runDb(
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
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
        yield* runMigrations(CURRENT_MIGRATIONS);
        yield* seed();
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        yield* tx.transact(
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
      }),
    ));

  it("fails closed on malformed durable episode binding with bounded integrity details", () =>
    runDb(
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
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
});
