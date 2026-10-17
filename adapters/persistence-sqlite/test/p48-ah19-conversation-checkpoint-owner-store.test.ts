import { DatabaseSync } from "node:sqlite";
import { ExecutionId, ProjectId, parse, WorkspaceId } from "@arbor/domain";
import {
  ConversationCheckpointStore,
  type HumanMessageStore,
  sha256Hex,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { createSchema47TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  ConversationCheckpointStoreLive,
  HumanMessageStoreLive,
  layer,
  P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const primarySessionId = "ses_ah19_owner_primary";
const executionSessionId = "ses_ah19_owner_execution";
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workerId = "worker:ah19-owner";
const workerIncarnationId = "incarnation:ah19-owner";
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1";
const manifestId = "mfest_ah19_owner_store";
const answeredMessageId = "msg_ah19_answered_1";
const pendingMessageId = "msg_ah19_pending_gap";
const laterAnsweredMessageId = "msg_ah19_answered_after_gap";
const claimedMessageId = "msg_ah19_claimed_current";
const answeredAt = "2026-10-17T00:01:00.000Z";
const pendingAt = "2026-10-17T00:02:00.000Z";
const laterAnsweredAt = "2026-10-17T00:03:00.000Z";
const claimedAt = "2026-10-17T00:04:00.000Z";
const updateAt = "2026-10-17T00:05:00.000Z";
const fence = (generation = 3) => ({
  executionId,
  workerId,
  workerIncarnationId,
  fencingGeneration: generation as never,
});

const upgrade = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename }),
      ),
    ),
  );

const makeApp = (filename: string) => {
  const sqlite = layer({ filename });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(ConversationCheckpointStoreLive, sqlite),
    Layer.provide(HumanMessageStoreLive, sqlite),
    Layer.provide(TransactionPortLive, sqlite),
  );
};

const seed = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                `INSERT INTO sessions (
                   session_id, binding_kind, workspace_id, execution_id,
                   context_epoch, created_at
                 ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0'),
                        (?, 'ExecutionScoped', NULL, ?, 0, 't0')`,
                [
                  primarySessionId,
                  workspaceId,
                  executionSessionId,
                  executionId,
                ],
              );
              yield* sql.unsafe(
                `INSERT INTO projects (
                   project_id, name, root_workspace_id, project_policy,
                   project_policy_revision, default_configuration, environment_ref,
                   lifecycle, revision, created_at, updated_at
                 ) VALUES (?, 'AH19 owner fixture', ?, '{}', 0, '{}', 'local',
                           'Open', 0, 't0', 't0')`,
                [projectId, workspaceId],
              );
              yield* sql.unsafe(
                `INSERT INTO workspaces (
                   workspace_id, project_id, parent_workspace_id, name,
                   responsibility_definition, responsibility_revision,
                   resource_boundary, resource_boundary_revision, agent_binding,
                   primary_session_id, current_work_id, workspace_policy,
                   workspace_policy_revision, revision, lifecycle, created_at, updated_at
                 ) VALUES (?, ?, NULL, 'Root', '{}', 0, '{}', 0, '{}', ?, NULL,
                           '{}', 0, 0, 'Active', 't0', 't0')`,
                [workspaceId, projectId, primarySessionId],
              );
              const fixtureRows = [
                [
                  answeredMessageId,
                  "Declined",
                  "Answered",
                  answeredAt,
                  `exe:${answeredMessageId}`,
                  2,
                ],
                [pendingMessageId, "Answered", "Queued", pendingAt, null, 0],
                [
                  laterAnsweredMessageId,
                  "Pending",
                  "Answered",
                  laterAnsweredAt,
                  `exe:${laterAnsweredMessageId}`,
                  2,
                ],
                [
                  claimedMessageId,
                  "Claimed",
                  "Running",
                  claimedAt,
                  executionId,
                  1,
                ],
              ] as const;
              for (const [
                messageId,
                legacyState,
                jobState,
                createdAt,
                responseExecutionId,
                revision,
              ] of fixtureRows) {
                yield* sql.unsafe(
                  `INSERT INTO human_messages (
                     message_id, project_id, root_workspace_id, human_principal,
                     body_ref, command_id, fingerprint, state,
                     claimed_by_execution_id, created_at, settled_at,
                     response_body, attempt_no, provider_reasoning_json
                   ) VALUES (?, ?, ?, 'user:test', ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
                  [
                    messageId,
                    projectId,
                    workspaceId,
                    `body:${messageId}`,
                    `cmd:${messageId}`,
                    `fp:${messageId}`,
                    legacyState,
                    legacyState === "Claimed" ? "exe:legacy-stale-claim" : null,
                    createdAt,
                    legacyState === "Answered" ? `${createdAt}:answered` : null,
                    legacyState === "Answered" ? "legacy wrong response" : null,
                  ],
                );
                yield* sql.unsafe(
                  `INSERT INTO conversation_response_jobs (
                     message_id, project_id, root_workspace_id, state,
                     active_execution_id, next_attempt_no, next_eligible_at,
                     attention_reason, last_failure_class, last_failure_fingerprint,
                     policy_version, response_body, response_execution_id,
                     provider_reasoning_json, revision, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                     'conversation-retry-v1', ?, ?, NULL, ?, ?, ?)`,
                  [
                    messageId,
                    projectId,
                    workspaceId,
                    jobState,
                    jobState === "Running" ? executionId : null,
                    jobState === "Queued" ? 0 : 1,
                    jobState === "Answered" ? `Job answer:${messageId}` : null,
                    jobState === "Answered" ? responseExecutionId : null,
                    revision,
                    createdAt,
                    createdAt,
                  ],
                );
              }
              for (const [
                messageId,
                ,
                jobState,
                createdAt,
                responseExecutionId,
              ] of fixtureRows) {
                if (jobState === "Queued") continue;
                const itemExecutionId = responseExecutionId ?? executionId;
                const answered = jobState === "Answered";
                const settlement = answered
                  ? JSON.stringify({
                      _tag: "Completed",
                      result: {
                        _tag: "ConversationResponseProduced",
                        messageId,
                      },
                    })
                  : null;
                yield* sql.unsafe(
                  `INSERT INTO executions (
                     execution_id, project_id, binding_kind, workspace_id,
                     episode_kind, episode_ref, episode_revision, parent_execution_id,
                     mission, session_id, admitted_at, stop_requested_at,
                     settlement_kind, settlement_json, settled_at
                   ) VALUES (?, ?, 'workspace', ?, 'ConversationResponseEpisode', ?,
                             0, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
                  [
                    itemExecutionId,
                    projectId,
                    workspaceId,
                    messageId,
                    executionSessionId,
                    createdAt,
                    answered ? "Completed" : null,
                    settlement,
                    answered ? `${createdAt}:settled` : null,
                  ],
                );
                yield* sql.unsafe(
                  `INSERT INTO conversation_attempts (
                     message_id, attempt_no, execution_id, admitted_at, settled_at,
                     settlement_kind, failure_class, failure_fingerprint,
                     retry_decision_json, policy_version
                   ) VALUES (?, 0, ?, ?, ?, ?, NULL, NULL, ?,
                             'conversation-retry-v1')`,
                  [
                    messageId,
                    itemExecutionId,
                    createdAt,
                    answered ? `${createdAt}:settled` : null,
                    answered ? "Completed" : null,
                    answered ? JSON.stringify({ _tag: "Answer" }) : null,
                  ],
                );
              }
              yield* sql.unsafe(
                `INSERT INTO execution_leases (
                   execution_id, worker_id, worker_incarnation_id, generation,
                   expires_at, updated_at
                 ) VALUES (?, ?, ?, 3, '2099-01-01T00:00:00.000Z', 't4')`,
                [executionId, workerId, workerIncarnationId],
              );
              yield* sql.unsafe(
                `INSERT INTO provider_turns (
                   provider_turn_id, execution_id, session_id, context_epoch,
                   model_ref, output_contract_ref, manifest_id, started_at,
                   settled_at, finish_reason, usage_json, created_at
                 ) VALUES (?, ?, ?, 0, 'model', 'contract', ?, 't4', NULL,
                           NULL, NULL, 't4')`,
                [providerTurnId, executionId, executionSessionId, manifestId],
              );
              yield* sql.unsafe(
                `INSERT INTO model_context_manifests (
                   manifest_id, provider_turn_id, execution_id, session_id,
                   context_epoch, model_ref, compiled_request_hash, manifest_json,
                   created_at, portable_request_json
                 ) VALUES (?, ?, ?, ?, 0, 'model', 'hash', '{}', 't4', '{}')`,
                [manifestId, providerTurnId, executionId, executionSessionId],
              );
            }),
          );
        }),
        layer({ filename }),
      ),
    ),
  );

const runStore = <A>(
  filename: string,
  program: Effect.Effect<
    A,
    unknown,
    | ConversationCheckpointStore
    | HumanMessageStore
    | TransactionPort
    | SqlClient
  >,
) =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp(filename))));

const sourceManifest = (coveredThroughMessageId = answeredMessageId) => ({
  version: 1 as const,
  rootWorkspaceId: workspaceId,
  fromEpoch: 0 as never,
  toEpoch: 1 as never,
  fromFrontier: null,
  coveredThrough: {
    createdAt: answeredAt,
    messageId: coveredThroughMessageId,
  },
  coveredSources: [
    {
      createdAt: answeredAt,
      messageId: answeredMessageId,
      bodyRef: `body:${answeredMessageId}`,
      bodySha256: sha256Hex(`body:${answeredMessageId}`),
      responseBodySha256: sha256Hex(`Job answer:${answeredMessageId}`),
      answeredJobRevision: 2,
      responseExecutionId: `exe:${answeredMessageId}` as never,
      attemptNo: 0,
      admissionJobRevision: 0,
    },
  ],
  currentMessageId: claimedMessageId,
  currentRunningJobRevision: 1,
  currentRunningAttemptNo: 0,
  currentAdmissionJobRevision: 0,
  checkpointKind: "Summary" as const,
  producerExecutionId: executionId,
  producerProviderTurnId: providerTurnId as never,
  producerManifestId: "mfest_ah19_owner_store",
});

const commitInput = (overrides: Record<string, unknown> = {}) => ({
  rootWorkspaceId: workspaceId,
  expectedContextEpoch: 0 as never,
  expectedCoveredThrough: null,
  nextContextEpoch: 1 as never,
  coveredThrough: {
    createdAt: answeredAt,
    messageId: answeredMessageId,
  },
  checkpointKind: "Summary" as const,
  checkpointRef: "blob:summary-v1",
  bindingFingerprint: null,
  sourceManifest: sourceManifest(),
  producerExecutionId: executionId,
  producerProviderTurnId: providerTurnId as never,
  updatedAt: updateAt,
  fence: fence(),
  ...overrides,
});

describe("P48 ConversationCheckpointStore owner CAS", () => {
  it("initializes exactly one RootWorkspace owner and commits an inclusive Answered prefix by epoch/frontier CAS", async () => {
    const fixture = await createSchema47TestDatabase();
    try {
      await upgrade(fixture.databaseFilename);
      await seed(fixture.databaseFilename);
      const committed = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ConversationCheckpointStore;
          const initial = yield* tx.transact(
            store.initializeIfAbsent({
              rootWorkspaceId: workspaceId,
              initializedAt: claimedAt,
              fence: fence(),
            }),
          );
          const repeated = yield* tx.transact(
            store.initializeIfAbsent({
              rootWorkspaceId: workspaceId,
              initializedAt: updateAt,
              fence: fence(),
            }),
          );
          expect(initial).toMatchObject({
            rootWorkspaceId: workspaceId,
            contextEpoch: 0,
            coveredThrough: null,
            checkpointKind: null,
            checkpointRef: null,
          });
          expect(repeated).toEqual(initial);
          const owner = yield* tx.transact(
            store.commit(commitInput() as never),
          );
          const read = yield* tx.transact(store.findOwner(workspaceId));
          return { owner, read };
        }),
      );
      expect(committed.owner).toMatchObject({
        rootWorkspaceId: workspaceId,
        contextEpoch: 1,
        coveredThrough: { createdAt: answeredAt, messageId: answeredMessageId },
        checkpointKind: "Summary",
        checkpointRef: "blob:summary-v1",
        producerExecutionId: executionId,
        producerProviderTurnId: providerTurnId,
      });
      expect(Option.getOrNull(committed.read)).toEqual(committed.owner);
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT root_workspace_id, context_epoch FROM conversation_checkpoint_owners",
            )
            .all(),
        ).toEqual([{ root_workspace_id: workspaceId, context_epoch: 1 }]);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a gap-crossing frontier, stale CAS, invalid Native binding, and expired lease without overwriting the owner", async () => {
    const fixture = await createSchema47TestDatabase();
    try {
      await upgrade(fixture.databaseFilename);
      await seed(fixture.databaseFilename);
      const results = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ConversationCheckpointStore;
          yield* tx.transact(
            store.initializeIfAbsent({
              rootWorkspaceId: workspaceId,
              initializedAt: claimedAt,
              fence: fence(),
            }),
          );
          const gap = yield* Effect.exit(
            tx.transact(
              store.commit(
                commitInput({
                  coveredThrough: {
                    createdAt: laterAnsweredAt,
                    messageId: laterAnsweredMessageId,
                  },
                  sourceManifest: sourceManifest(laterAnsweredMessageId),
                }) as never,
              ),
            ),
          );
          const native = yield* Effect.exit(
            tx.transact(
              store.commit(
                commitInput({
                  checkpointKind: "ProviderNative",
                  checkpointRef: "opaque:native-state",
                  bindingFingerprint: null,
                }) as never,
              ),
            ),
          );
          const committed = yield* tx.transact(
            store.commit(commitInput() as never),
          );
          const stale = yield* Effect.exit(
            tx.transact(store.commit(commitInput() as never)),
          );
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            "UPDATE execution_leases SET expires_at = '2026-10-16T00:00:00.000Z' WHERE execution_id = ?",
            [executionId],
          );
          const expired = yield* Effect.exit(
            tx.transact(
              store.commit(
                commitInput({
                  expectedContextEpoch: 1 as never,
                  nextContextEpoch: 2 as never,
                  sourceManifest: {
                    ...sourceManifest(),
                    fromEpoch: 1,
                    toEpoch: 2,
                  },
                  updatedAt: "2026-10-17T00:06:00.000Z",
                }) as never,
              ),
            ),
          );
          return { gap, native, committed, stale, expired };
        }),
      );
      expect(Exit.isFailure(results.gap)).toBe(true);
      expect(Exit.isFailure(results.native)).toBe(true);
      expect(results.committed.contextEpoch).toBe(1);
      expect(Exit.isFailure(results.stale)).toBe(true);
      expect(Exit.isFailure(results.expired)).toBe(true);
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT context_epoch, covered_through_message_id, checkpoint_kind FROM conversation_checkpoint_owners WHERE root_workspace_id = ?",
            )
            .get(workspaceId),
        ).toEqual({
          context_epoch: 1,
          covered_through_message_id: answeredMessageId,
          checkpoint_kind: "Summary",
        });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("serializes competing owner-frontier commits so exactly one epoch CAS wins", async () => {
    const fixture = await createSchema47TestDatabase();
    try {
      await upgrade(fixture.databaseFilename);
      await seed(fixture.databaseFilename);
      await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ConversationCheckpointStore;
          yield* tx.transact(
            store.initializeIfAbsent({
              rootWorkspaceId: workspaceId,
              initializedAt: claimedAt,
              fence: fence(),
            }),
          );
        }),
      );
      const contender = () =>
        runStore(
          fixture.databaseFilename,
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const store = yield* ConversationCheckpointStore;
            return yield* tx.transact(store.commit(commitInput() as never));
          }),
        );
      const outcomes = await Promise.allSettled([contender(), contender()]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toHaveLength(1);
      const read = await runStore(
        fixture.databaseFilename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ConversationCheckpointStore;
          return yield* tx.transact(store.findOwner(workspaceId));
        }),
      );
      expect(Option.getOrNull(read)).toMatchObject({
        contextEpoch: 1,
        coveredThrough: { createdAt: answeredAt, messageId: answeredMessageId },
      });
    } finally {
      fixture.cleanup();
    }
  });
});
