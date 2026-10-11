import {
  AttentionProjectionStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeRecoveryAttentionFactStoreLive,
  runMigrations,
  TransactionPortLive,
  P37_MIGRATIONS,
} from "../src/index.js";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AttentionProjectionStore,
  DomainEventJournal,
  RecoveryAttentionFactStore,
  TransactionPort,
} from "@arbor/ports";

const projectId = "prj_deliver_replay_test";
const workspaceId = "ws_deliver_replay_test";
const executionId = "exe_deliver_replay_test";

const makeApp = () => {
  const sqlite = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(sqlite, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const stores = Layer.mergeAll(
    journal,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(AttentionProjectionStoreLive, sqlite),
    Layer.provide(
      makeRecoveryAttentionFactStoreLive(),
      Layer.mergeAll(infra, journal),
    ),
  );
  return Layer.mergeAll(infra, stores);
};

const runDb = <A>(
  program: Effect.Effect<
    A,
    unknown,
    | SqlClient
    | AttentionProjectionStore
    | DomainEventJournal
    | RecoveryAttentionFactStore
    | TransactionPort
  >,
) => Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

const seedExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'DeliverReplay fixture', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
        [projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES ('ses_deliver_replay_test', 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'Root', '{}', 0, '{}', 0, '{}',
          'ses_deliver_replay_test', NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
        [workspaceId, projectId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', 'wrk_test', 0,
          NULL, NULL, 'ses_deliver_replay_test', 't0', NULL, NULL, NULL, NULL)`,
        [executionId, projectId, workspaceId],
      );
    }),
  );
});

describe("P37 DeliverReplay durable outbox", () => {
  it("keeps the immutable fact/event and requeues only after ACK", () =>
    runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        const attention = yield* AttentionProjectionStore;
        yield* runMigrations(P37_MIGRATIONS);
        yield* seedExecution;
        const input = {
          projectId: projectId as never,
          executionId: executionId as never,
          targetWorkspaceId: workspaceId as never,
          logicalActionId: "act_deliver_replay_test",
          messageId: "msg_deliver_replay_test",
          failureCode: "LegacyMessageMissingEvent" as const,
          firstDetectedAt: "2026-10-11T00:00:00.000Z",
        };
        const first = yield* tx.transact(facts.recordDeliverReplayFailure(input));
        const duplicate = yield* tx.transact(
          facts.recordDeliverReplayFailure({
            ...input,
            failureCode: "LegacyInboxConflict",
            firstDetectedAt: "2026-10-11T00:00:01.000Z",
          }),
        );
        const counts = yield* sql.unsafe<{
          readonly facts: number;
          readonly events: number;
          readonly queued: number;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM deliver_replay_attention_facts) AS facts,
             (SELECT COUNT(*) FROM domain_events WHERE event_type = 'DeliverReplayEscalated') AS events,
             (SELECT COUNT(*) FROM deliver_replay_attention_pending) AS queued`,
        );
        expect(duplicate).toEqual(first);
        expect(Number(counts[0]?.facts)).toBe(1);
        expect(Number(counts[0]?.events)).toBe(1);
        expect(Number(counts[0]?.queued)).toBe(1);

        yield* tx.transact(attention.putDeliverReplayFailure(first));
        const projected = yield* tx.transact(
          attention.listDeliverReplayFailures(projectId as never),
        );
        expect(projected).toEqual([
          expect.objectContaining({
            dedupKey: first.attentionFactId,
            source: "DeliverReplayFailure",
            severity: "ActionRequired",
            targetWorkspaceId: workspaceId,
            failureCode: "LegacyMessageMissingEvent",
          }),
        ]);
        yield* tx.transact(
          facts.acknowledgePendingDeliverReplayAttention(first.attentionFactId),
        );
        yield* tx.transact(facts.recordDeliverReplayFailure(input));
        const requeued = yield* sql.unsafe<{ readonly queued: number }>(
          "SELECT COUNT(*) AS queued FROM deliver_replay_attention_pending",
        );
        expect(Number(requeued[0]?.queued)).toBe(1);
      }),
    ),
  );

  it("rejects queue deletion until the P10 fact marker exists", () =>
    runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        yield* runMigrations(P37_MIGRATIONS);
        yield* seedExecution;
        const fact = yield* tx.transact(
          facts.recordDeliverReplayFailure({
            projectId: projectId as never,
            executionId: executionId as never,
            targetWorkspaceId: workspaceId as never,
            logicalActionId: "act_no_marker",
            messageId: "msg_no_marker",
            failureCode: "LegacyMessageMissingEvent",
            firstDetectedAt: "2026-10-11T00:00:00.000Z",
          }),
        );
        const attempt = yield* Effect.exit(
          tx.transact(
            facts.acknowledgePendingDeliverReplayAttention(
              fact.attentionFactId,
            ),
          ),
        );
        const queued = yield* sql.unsafe<{ readonly queued: number }>(
          "SELECT COUNT(*) AS queued FROM deliver_replay_attention_pending",
        );
        expect(Exit.isFailure(attempt)).toBe(true);
        expect(Number(queued[0]?.queued)).toBe(1);
      }),
    ),
  );
});
