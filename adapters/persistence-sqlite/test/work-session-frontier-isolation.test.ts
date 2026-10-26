import { SessionRepository, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  layer,
  P21_MIGRATIONS,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1";
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";
const conversationExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a2";
const priorWorkExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a3";
const activeWorkExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a4";
const conversationTurnId = `ptn_${conversationExecutionId}_0`;
const conversationCheckpointTurnId = `ptn_${conversationExecutionId}_0_compact_0`;
const priorWorkTurnId = `ptn_${priorWorkExecutionId}_0`;
const activeWorkTurnId = `ptn_${activeWorkExecutionId}_0`;

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
  );
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
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
          "w",
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
    }),
  );
});

describe("Work Session frontier ownership", () => {
  it("excludes other execution history while retaining exact current-turn reasoning", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe("ALTER TABLE executions ADD COLUMN episode_kind TEXT");
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?, ?, 'workspace', ?, 'coordination', NULL, NULL, NULL, ?, 't', NULL, NULL, NULL, NULL)",
        [conversationExecutionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        "UPDATE executions SET episode_kind = 'ConversationResponseEpisode' WHERE execution_id = ?",
        [conversationExecutionId],
      );
      for (const executionId of [priorWorkExecutionId, activeWorkExecutionId]) {
        yield* sql.unsafe(
          "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at, episode_kind) VALUES (?, ?, 'workspace', ?, 'coordination', NULL, NULL, NULL, ?, 't', NULL, 'Completed', '{}', 't', 'WorkEpisode')",
          [executionId, projectId, workspaceId, sessionId],
        );
      }
      for (const providerTurnId of [
        conversationTurnId,
        conversationCheckpointTurnId,
        priorWorkTurnId,
        activeWorkTurnId,
      ]) {
        const executionId = providerTurnId.startsWith(
          `ptn_${conversationExecutionId}_`,
        )
          ? conversationExecutionId
          : providerTurnId.startsWith(`ptn_${priorWorkExecutionId}_`)
            ? priorWorkExecutionId
            : activeWorkExecutionId;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          [
            providerTurnId,
            executionId,
            sessionId,
            0,
            "model-test",
            "tool-invocation-v1",
            `manifest-${providerTurnId}`,
            "t",
            "t",
          ],
        );
      }
      const insert = (
        sequence: number,
        entryKind: string,
        itemType: string,
        sourceKind: string,
        sourceRef: string,
        payload: unknown,
      ) =>
        sql.unsafe(
          "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?,?,?,?,2,0,?,'t',?,?,?)",
          [
            sessionId,
            sequence,
            entryKind,
            itemType,
            JSON.stringify(payload),
            sourceKind,
            sourceRef,
            `hash-${sequence}`,
          ],
        );

      yield* insert(
        1,
        "ModelOutput",
        "AssistantMessage",
        "ProviderTurn",
        conversationTurnId,
        {
          _tag: "AssistantMessage",
          providerTurnId: conversationTurnId,
          contentRef: `provider:${conversationTurnId}:assistant`,
          text: "root response",
          finishReason: "tool_calls",
        },
      );
      yield* insert(
        2,
        "ModelOutput",
        "AttachmentRef",
        "ProviderTurnReasoning",
        `${conversationTurnId}:reasoning`,
        {
          _tag: "AttachmentRef",
          ref: "blob:root-reasoning",
          mediaType: "application/vnd.arbor.provider-reasoning-v1+json",
          trust: "DataOnly",
          providerTurnId: conversationTurnId,
        },
      );
      yield* insert(
        3,
        "ModelOutput",
        "ToolCall",
        "ProviderTurnCall",
        `${conversationTurnId}:assign-work-call`,
        {
          _tag: "ToolCall",
          providerTurnId: conversationTurnId,
          callRef: "assign-work-call",
          toolRef: "assign_work",
          argumentsJson: "{}",
        },
      );
      yield* insert(
        4,
        "Observation",
        "ControlResult",
        "AgentLoopAction",
        `observation_${conversationExecutionId}_${"a".repeat(64)}`,
        {
          _tag: "ControlResult",
          callRef: "assign-work-call",
          actionKind: "assign_work",
          status: "Succeeded",
          disposition: "Applied",
          outputText: "accepted",
          truncated: false,
          canonicalRefs: [],
          observationRef: `observation_${conversationExecutionId}_${"a".repeat(64)}`,
        },
      );
      yield* insert(
        10,
        "CheckpointReference",
        "CompactionCheckpoint",
        "CompactionTurn",
        conversationCheckpointTurnId,
        {
          _tag: "CompactionCheckpoint",
          implementation: "Summary",
          fromEpoch: 0,
          toEpoch: 1,
          summaryText: "root conversation checkpoint",
        },
      );
      yield* insert(
        11,
        "ModelOutput",
        "AssistantMessage",
        "ProviderTurn",
        priorWorkTurnId,
        {
          _tag: "AssistantMessage",
          providerTurnId: priorWorkTurnId,
          contentRef: `provider:${priorWorkTurnId}:assistant`,
          text: "terminal assistant output from prior Work execution",
          finishReason: "stop",
        },
      );
      yield* insert(
        12,
        "ModelOutput",
        "AssistantMessage",
        "ProviderTurn",
        activeWorkTurnId,
        {
          _tag: "AssistantMessage",
          providerTurnId: activeWorkTurnId,
          contentRef: `provider:${activeWorkTurnId}:assistant`,
          text: "active execution history",
          finishReason: "tool_calls",
        },
      );
      yield* insert(
        13,
        "ModelOutput",
        "AttachmentRef",
        "ProviderTurnReasoning",
        `${activeWorkTurnId}:reasoning`,
        {
          _tag: "AttachmentRef",
          ref: "blob:active-work-reasoning",
          mediaType: "application/vnd.arbor.provider-reasoning-v1+json",
          trust: "DataOnly",
          providerTurnId: activeWorkTurnId,
        },
      );

      const tx = yield* TransactionPort;
      const sessions = yield* SessionRepository;
      return yield* tx.transact(
        sessions.listWorkActiveFrontier(
          sessionId as never,
          activeWorkExecutionId as never,
        ),
      );
    });

    const entries = await Effect.runPromise(Effect.provide(program, app));
    expect(entries.map((entry) => entry.sequence)).toEqual([12, 13]);
    expect(
      entries.some((entry) =>
        JSON.stringify(entry.payload).includes("prior Work execution"),
      ),
    ).toBe(false);
    expect(
      entries.some((entry) => entry.source?.kind === "ProviderTurnReasoning"),
    ).toBe(true);
  });
});
