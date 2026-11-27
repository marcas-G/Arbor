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
import { seedWorkspaceGraph } from "./support/seed-workspace.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1";
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1";
const conversationExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a2";
const priorWorkExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a3";
const activeWorkExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a4";
const conversationTurnId = `ptn_${conversationExecutionId}_0`;
const conversationCheckpointTurnId = `ptn_${conversationExecutionId}_0_compact_0`;
const priorWorkTurnId = `ptn_${priorWorkExecutionId}_0`;
const priorPlainWorkTurnId = `ptn_${priorWorkExecutionId}_1`;
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

const seed = seedWorkspaceGraph({ projectId, workspaceId, sessionId });

describe("Work Session frontier ownership", () => {
  it("preserves causal Work binding for downstream frontier filtering", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "ALTER TABLE session_entries ADD COLUMN causal_binding_json TEXT",
      );
      const causalBinding = {
        projectId,
        workspaceId,
        executionId: activeWorkExecutionId,
        workId,
        episodeBinding: "WorkEpisode",
        causedByRef: "steer:revision:1",
      };
      yield* sql.unsafe(
        "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash, causal_binding_json) VALUES (?, 1, 'Input', 'UserMessage', 2, 0, ?, 't', 'InboxEntry', 'steer:revision:1', 'hash-1', ?)",
        [
          sessionId,
          JSON.stringify({
            _tag: "UserMessage",
            text: "bounded human direction",
          }),
          JSON.stringify(causalBinding),
        ],
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
    expect(entries).toHaveLength(1);
    expect(entries[0]?.causalBinding).toEqual({
      projectId,
      workspaceId,
      executionId: activeWorkExecutionId,
      workId,
      episodeBinding: "WorkEpisode",
      causedByRef: "steer:revision:1",
    });
  });

  it("preserves causal Work binding after a typed checkpoint", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "ALTER TABLE session_entries ADD COLUMN causal_binding_json TEXT",
      );
      const causalBinding = {
        projectId,
        workspaceId,
        executionId: activeWorkExecutionId,
        workId,
        episodeBinding: "WorkEpisode",
        causedByRef: "steer:revision:2",
      };
      yield* sql.unsafe(
        "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash, causal_binding_json) VALUES (?, 1, 'CheckpointReference', 'CompactionCheckpoint', 2, 0, ?, 't', 'CompactionTurn', 'ptn_checkpoint', 'hash-checkpoint', ?), (?, 2, 'Input', 'UserMessage', 2, 1, ?, 't', 'InboxEntry', 'steer:revision:2', 'hash-2', ?)",
        [
          sessionId,
          JSON.stringify({
            _tag: "CompactionCheckpoint",
            implementation: "Summary",
            fromEpoch: 0,
            toEpoch: 1,
            summaryText: "retained Work history",
          }),
          JSON.stringify(causalBinding),
          sessionId,
          JSON.stringify({
            _tag: "UserMessage",
            text: "post-checkpoint human direction",
          }),
          JSON.stringify(causalBinding),
        ],
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
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.causalBinding)).toEqual([
      {
        projectId,
        workspaceId,
        executionId: activeWorkExecutionId,
        workId,
        episodeBinding: "WorkEpisode",
        causedByRef: "steer:revision:2",
      },
      {
        projectId,
        workspaceId,
        executionId: activeWorkExecutionId,
        workId,
        episodeBinding: "WorkEpisode",
        causedByRef: "steer:revision:2",
      },
    ]);
  });

  it("does not use a foreign Work checkpoint as the active frontier root", async () => {
    const app = makeApp();
    const foreignWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789af";
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "ALTER TABLE session_entries ADD COLUMN causal_binding_json TEXT",
      );
      const checkpoint = (work: string, implementation: string) =>
        JSON.stringify({
          _tag: "CompactionCheckpoint",
          implementation,
          fromEpoch: 0,
          toEpoch: 1,
          retainedFrontierRef: `frontier:${work}`,
          bindingFingerprint: null,
        });
      const binding = (work: string) =>
        JSON.stringify({
          projectId,
          workspaceId,
          executionId: activeWorkExecutionId,
          workId: work,
          episodeBinding: "WorkEpisode",
          causedByRef: `provider:${work}`,
        });
      yield* sql.unsafe(
        "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash, causal_binding_json) VALUES (?, 1, 'CheckpointReference', 'CompactionCheckpoint', 2, 1, ?, 't', 'CompactionTurn', 'ptn_current_compact', 'hash-current', ?), (?, 2, 'CheckpointReference', 'CompactionCheckpoint', 2, 1, ?, 't', 'CompactionTurn', 'ptn-foreign-compact', 'hash-foreign', ?)",
        [
          sessionId,
          checkpoint(workId, "Summary"),
          binding(workId),
          sessionId,
          checkpoint(foreignWorkId, "ProviderNative"),
          binding(foreignWorkId),
        ],
      );

      const tx = yield* TransactionPort;
      const sessions = yield* SessionRepository;
      return yield* tx.transact(
        sessions.listWorkActiveFrontier(
          sessionId as never,
          activeWorkExecutionId as never,
          workId as never,
        ),
      );
    });

    const entries = await Effect.runPromise(Effect.provide(program, app));
    expect(entries.map((entry) => entry.sequence)).toEqual([1]);
    expect(entries[0]?.payload).toMatchObject({
      implementation: "Summary",
      retainedFrontierRef: `frontier:${workId}`,
    });
  });

  it("retains bound prior Work actions while excluding unbound and foreign rows", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "ALTER TABLE session_entries ADD COLUMN causal_binding_json TEXT",
      );
      const insert = (
        sequence: number,
        payload: unknown,
        causalBinding?: unknown,
      ) =>
        sql.unsafe(
          "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash, causal_binding_json) VALUES (?, ?, 'ModelOutput', 'ToolCall', 2, 0, ?, 't', 'ProviderTurnCall', ?, ?, ?)",
          [
            sessionId,
            sequence,
            JSON.stringify(payload),
            `ptn_${priorWorkExecutionId}_0:call-${sequence}`,
            `hash-${sequence}`,
            causalBinding === undefined ? null : JSON.stringify(causalBinding),
          ],
        );
      const workBinding = {
        projectId,
        workspaceId,
        executionId: priorWorkExecutionId,
        workId,
        episodeBinding: "WorkEpisode",
        causedByRef: "provider:prior",
      };
      yield* insert(1, { _tag: "ToolCall", callRef: "bound" }, workBinding);
      yield* insert(2, { _tag: "ToolCall", callRef: "unbound" });
      yield* insert(
        3,
        { _tag: "ToolCall", callRef: "foreign" },
        {
          ...workBinding,
          workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789af",
        },
      );

      const tx = yield* TransactionPort;
      const sessions = yield* SessionRepository;
      return yield* tx.transact(
        sessions.listWorkActiveFrontier(
          sessionId as never,
          activeWorkExecutionId as never,
          workId as never,
        ),
      );
    });

    const entries = await Effect.runPromise(Effect.provide(program, app));
    expect(entries.map((entry) => entry.sequence)).toEqual([1]);
    expect(entries[0]?.causalBinding).toMatchObject({
      executionId: priorWorkExecutionId,
      workId,
      episodeBinding: "WorkEpisode",
    });
  });

  it("keeps plain prior Work output while excluding prior tool-call causal groups", async () => {
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
        priorPlainWorkTurnId,
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
        `${priorPlainWorkTurnId}:assistant`,
        {
          _tag: "AssistantMessage",
          providerTurnId: priorPlainWorkTurnId,
          contentRef: `provider:${priorPlainWorkTurnId}:assistant`,
          text: "plain assistant output from prior Work execution",
          finishReason: "stop",
        },
      );
      yield* insert(
        12,
        "ModelOutput",
        "AssistantMessage",
        "ProviderTurn",
        `${priorWorkTurnId}:assistant`,
        {
          _tag: "AssistantMessage",
          providerTurnId: priorWorkTurnId,
          contentRef: `provider:${priorWorkTurnId}:assistant`,
          text: "terminal assistant output from prior Work execution",
          finishReason: "stop",
        },
      );
      yield* insert(
        13,
        "ModelOutput",
        "AttachmentRef",
        "ProviderTurnReasoning",
        `${priorWorkTurnId}:reasoning`,
        {
          _tag: "AttachmentRef",
          ref: "blob:prior-work-reasoning",
          mediaType: "application/vnd.arbor.provider-reasoning+json",
          trust: "DataOnly",
          providerTurnId: priorWorkTurnId,
        },
      );
      yield* insert(
        14,
        "ModelOutput",
        "ToolCall",
        "ProviderTurnCall",
        `${priorWorkTurnId}:reused-call`,
        {
          _tag: "ToolCall",
          providerTurnId: priorWorkTurnId,
          callRef: "reused-call",
          toolRef: "read",
          argumentsRef: "inline:old",
          argumentsJson: "{}",
        },
      );
      yield* insert(
        15,
        "Observation",
        "ToolResult",
        "AgentLoopAction",
        `observation_${priorWorkExecutionId}_${"b".repeat(64)}`,
        {
          _tag: "ToolResult",
          callRef: "old-call",
          toolName: "read",
          status: "Succeeded",
          observationRef: `observation_${priorWorkExecutionId}_${"b".repeat(64)}`,
          outputText: "old result",
        },
      );
      for (const [invocationId, ownerExecutionId] of [
        ["tin_old_work", priorWorkExecutionId],
        ["tin_active_work", activeWorkExecutionId],
      ] as const) {
        yield* sql.unsafe(
          "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES (?, ?, ?, 'read', '1', 'ReadOnly', '{}', '[]', 't', NULL, NULL, NULL, NULL)",
          [invocationId, ownerExecutionId, workspaceId],
        );
      }
      yield* insert(
        16,
        "Observation",
        "ToolResult",
        "ToolInvocation",
        "tin_old_work",
        {
          _tag: "ToolResult",
          callRef: "old-invocation-call",
          toolName: "read",
          status: "Succeeded",
          observationRef: "observation_old_invocation",
          outputText: "old invocation result",
        },
      );
      yield* insert(
        17,
        "ModelOutput",
        "AssistantMessage",
        "ProviderTurn",
        `${activeWorkTurnId}:assistant`,
        {
          _tag: "AssistantMessage",
          providerTurnId: activeWorkTurnId,
          contentRef: `provider:${activeWorkTurnId}:assistant`,
          text: "active execution history",
          finishReason: "tool_calls",
        },
      );
      yield* insert(
        18,
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
      yield* insert(
        19,
        "ModelOutput",
        "ToolCall",
        "ProviderTurnCall",
        `${activeWorkTurnId}:reused-call`,
        {
          _tag: "ToolCall",
          providerTurnId: activeWorkTurnId,
          callRef: "reused-call",
          toolRef: "read",
          argumentsRef: "inline:current",
          argumentsJson: "{}",
        },
      );
      yield* insert(
        20,
        "Observation",
        "ToolResult",
        "SessionFrontierRepair",
        `session-frontier-repair:v1:${activeWorkExecutionId}:${activeWorkTurnId}:${"c".repeat(64)}`,
        {
          _tag: "ToolResult",
          callRef: "reused-call",
          toolName: "read",
          status: "Succeeded",
          observationRef: `observation_${"c".repeat(64)}`,
          outputText: "current result",
        },
      );
      yield* insert(
        21,
        "Observation",
        "ToolResult",
        "ToolInvocation",
        "tin_active_work",
        {
          _tag: "ToolResult",
          callRef: "current-invocation-call",
          toolName: "read",
          status: "Succeeded",
          observationRef: "observation_current_invocation",
          outputText: "current invocation result",
        },
      );
      yield* insert(
        22,
        "Observation",
        "ToolResult",
        "SessionFrontierRepair",
        `session-frontier-repair:v1:${priorWorkExecutionId}:${priorWorkTurnId}:${"d".repeat(64)}`,
        {
          _tag: "ToolResult",
          callRef: "reused-call",
          toolName: "read",
          status: "Interrupted",
          observationRef: `observation_${"d".repeat(64)}`,
          outputText: "prior execution repair result",
        },
      );
      // Legacy repair rows do not identify an execution or ProviderTurn and
      // must remain excluded from execution-scoped context.
      yield* insert(
        23,
        "Observation",
        "ToolResult",
        "SessionFrontierRepair",
        `observation_${"e".repeat(64)}`,
        {
          _tag: "ToolResult",
          callRef: "reused-call",
          toolName: "read",
          status: "Interrupted",
          observationRef: `observation_${"e".repeat(64)}`,
          outputText: "legacy repair result without ownership",
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
    expect(entries.map((entry) => entry.sequence)).toEqual([
      11, 17, 18, 19, 20, 21,
    ]);
    expect(entries.some((entry) => entry.sequence === 20)).toBe(true);
    expect(entries.some((entry) => entry.sequence === 22)).toBe(false);
    expect(entries.some((entry) => entry.sequence === 23)).toBe(false);
    expect(
      entries.find((entry) => entry.sequence === 20)?.payload,
    ).toMatchObject({
      callRef: "reused-call",
      status: "Succeeded",
    });
    expect(
      entries.some((entry) =>
        JSON.stringify(entry.payload).includes(
          "plain assistant output from prior Work execution",
        ),
      ),
    ).toBe(true);
    expect(
      entries.some((entry) =>
        JSON.stringify(entry.payload).includes(
          "terminal assistant output from prior Work execution",
        ),
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.source?.kind === "ProviderTurnReasoning" &&
          entry.source.ref === `${activeWorkTurnId}:reasoning`,
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.source?.kind === "ProviderTurnReasoning" &&
          entry.source.ref === `${priorWorkTurnId}:reasoning`,
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.source?.kind === "ProviderTurnCall" &&
          entry.source.ref === `${priorWorkTurnId}:old-call`,
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.source?.kind === "AgentLoopAction" &&
          entry.source.ref.startsWith(`observation_${priorWorkExecutionId}_`),
      ),
    ).toBe(false);
    expect(entries.some((entry) => entry.source?.ref === "tin_old_work")).toBe(
      false,
    );
    expect(
      entries.some(
        (entry) =>
          entry.source?.kind === "ToolInvocation" &&
          entry.source.ref === "tin_active_work",
      ),
    ).toBe(true);
  });

  it("takes the raw latest-64 window before schema and Conversation filtering", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe("ALTER TABLE executions ADD COLUMN episode_kind TEXT");
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at, episode_kind) VALUES (?, ?, 'workspace', ?, 'coordination', NULL, NULL, NULL, ?, 't', NULL, NULL, NULL, NULL, 'ConversationResponseEpisode')",
        [conversationExecutionId, projectId, workspaceId, sessionId],
      );

      const insertTyped = (
        sequence: number,
        entryKind: string,
        itemType: string,
        sourceKind: string,
        sourceRef: string,
        payload: unknown,
      ) =>
        sql.unsafe(
          "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?, ?, ?, ?, 2, 0, ?, 't', ?, ?, ?)",
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

      // These eligible rows are older than the raw 64-row window and must not
      // be pulled back to replace rows filtered from within that window.
      for (let sequence = 0; sequence <= 2; sequence += 1) {
        yield* insertTyped(
          sequence,
          "Input",
          "UserMessage",
          "test",
          `old-${sequence}`,
          { _tag: "UserMessage", text: `old-${sequence}` },
        );
      }

      // A legacy row still occupies one of the 64 raw Session positions.
      yield* sql.unsafe(
        "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?, 3, 'Input', 'LegacyInput', 1, NULL, ?, 't', 'test', 'legacy-window-row', 'hash-3')",
        [
          sessionId,
          JSON.stringify({ _tag: "UserMessage", text: "legacy-window-row" }),
        ],
      );

      for (let sequence = 4; sequence <= 65; sequence += 1) {
        yield* insertTyped(
          sequence,
          "Input",
          "UserMessage",
          "test",
          `work-${sequence}`,
          { _tag: "UserMessage", text: `work-${sequence}` },
        );
      }
      // Conversation-owned rows also occupy the raw window before exclusion.
      yield* insertTyped(
        66,
        "ModelOutput",
        "AssistantMessage",
        "ProviderTurn",
        `ptn_${conversationExecutionId}_0:assistant`,
        {
          _tag: "AssistantMessage",
          providerTurnId: `ptn_${conversationExecutionId}_0`,
          contentRef: `provider:ptn_${conversationExecutionId}_0:assistant`,
          text: "conversation-only",
          finishReason: "Stop",
        },
      );

      const tx = yield* TransactionPort;
      const sessions = yield* SessionRepository;
      return yield* tx.transact(
        sessions.listWorkActiveFrontier(sessionId as never),
      );
    });

    const entries = await Effect.runPromise(Effect.provide(program, app));
    expect(entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 62 }, (_, index) => index + 4),
    );
    expect(entries[0]?.payload).toMatchObject({ text: "work-4" });
    expect(entries.some((entry) => entry.sequence <= 3)).toBe(false);
    expect(entries.some((entry) => entry.sequence === 66)).toBe(false);
  });

  it("drops a result whose call was cut off by the raw latest-64 window", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      const insertTyped = (
        sequence: number,
        itemType: string,
        sourceKind: string,
        sourceRef: string,
        payload: unknown,
      ) =>
        sql.unsafe(
          "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?, ?, 'ModelOutput', ?, 2, 0, ?, 't', ?, ?, ?)",
          [
            sessionId,
            sequence,
            itemType,
            JSON.stringify(payload),
            sourceKind,
            sourceRef,
            `hash-${sequence}`,
          ],
        );

      // Sequence 0 is outside the raw latest-64 window, while sequence 2 is
      // inside it. The result must not become a synthetic contradictory
      // timeline entry after its call has been trimmed away.
      yield* insertTyped(
        0,
        "ToolCall",
        "ProviderTurnCall",
        "ptn_prior:call-trimmed",
        {
          _tag: "ToolCall",
          providerTurnId: "ptn_prior",
          callRef: "call-trimmed",
          toolRef: "read",
          argumentsJson: "{}",
        },
      );
      yield* insertTyped(1, "UserMessage", "InboxEntry", "input-1", {
        _tag: "UserMessage",
        text: "context",
      });
      yield* insertTyped(
        2,
        "ToolResult",
        "AgentLoopAction",
        "observation-trimmed",
        {
          _tag: "ToolResult",
          callRef: "call-trimmed",
          toolName: "read",
          status: "Succeeded",
          outputText: "must not enter the frontier",
        },
      );
      for (let sequence = 3; sequence <= 65; sequence += 1) {
        yield* insertTyped(
          sequence,
          "UserMessage",
          "InboxEntry",
          `input-${sequence}`,
          { _tag: "UserMessage", text: `context-${sequence}` },
        );
      }

      const tx = yield* TransactionPort;
      const sessions = yield* SessionRepository;
      return yield* tx.transact(
        sessions.listWorkActiveFrontier(sessionId as never),
      );
    });

    const entries = await Effect.runPromise(Effect.provide(program, app));
    expect(entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 63 }, (_, index) => index + 3),
    );
    expect(entries.some((entry) => entry.sequence === 2)).toBe(false);
  });
});
