import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { P19_MIGRATIONS } from "../../adapters/persistence-sqlite/src/index.js";
import {
  ContextEpochNumber,
  ExecutionId,
  parse,
  providerTurnInferenceId,
} from "../../packages/domain/dist/index.js";
import {
  ModelContext,
  projectSessionTimeline,
} from "../../packages/model-context/src/index.js";
import {
  encodeReasoningAttachment,
  PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
  portableInputItems,
  type ReasoningAttachment,
  SessionRepository,
  sha256Hex,
  TransactionPort,
} from "../../packages/ports/src/index.js";

import {
  allowGate,
  context,
  drive,
  executionId,
  makeApp,
  projectId,
  run,
  runMigrations,
  seed,
  sessionId,
  textTurn,
  workspaceId,
} from "./support.js";

describe("P3-013 agent driver", () => {
  it("projects a real typed Session frontier through ModelContext.prepareTurn", async () => {
    const app = makeApp([textTurn]);
    const prepared = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const sessions = yield* SessionRepository;
        const tx = yield* TransactionPort;
        const outputTurnId = providerTurnInferenceId(executionId, 0);
        const priorExecutionId = parse(ExecutionId)(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a9",
        );
        const priorTurnId = providerTurnInferenceId(priorExecutionId, 0);
        const priorPlainTurnId = providerTurnInferenceId(priorExecutionId, 1);
        const sourceRef = `${outputTurnId}:assistant`;
        const outputText = "Accepted prior assistant output.";
        const bindingFingerprint = `p16fp_${"a".repeat(64)}`;
        const reasoningBinding = {
          modelRef: "model-test",
          protocolFamily: "openai-chat-completions-sse",
          bindingFingerprint,
        };
        const priorReasoning: ReasoningAttachment = {
          attachmentType: "provider-reasoning-v1",
          modelRef: "model-test",
          protocolFamily: "openai-chat-completions-sse",
          bindingFingerprint,
          opaquePayload: "OLD EXECUTION REASONING MUST NOT BE SENT",
          receivedAt: "2026-10-24T00:00:00.000Z",
        };
        const currentReasoning: ReasoningAttachment = {
          ...priorReasoning,
          opaquePayload: "CURRENT EXECUTION REASONING IS ALLOWED",
        };
        yield* sql.unsafe(
          "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, ?, 'prior Work execution fixture', ?, 't', NULL, NULL, NULL, NULL)",
          [priorExecutionId, projectId, workspaceId, executionId, sessionId],
        );
        for (const [turnId, ownerExecutionId, manifestId] of [
          [priorTurnId, priorExecutionId, "mft-prior-reasoning"],
          [priorPlainTurnId, priorExecutionId, "mft-prior-plain"],
          [outputTurnId, executionId, "mft-current-reasoning"],
        ] as const) {
          yield* sql.unsafe(
            "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, created_at) VALUES (?, ?, ?, 0, 'model-test', 'tool-invocation-v1', ?, 't', 't')",
            [turnId, ownerExecutionId, sessionId, manifestId],
          );
        }
        const append = (
          item: Record<string, unknown>,
          kind: string,
          ref: string,
          contentHash = sha256Hex(JSON.stringify(item)),
        ) =>
          tx.transact(
            sessions.appendItemIdempotent(
              sessionId,
              {
                item: item as never,
                contextEpoch: parse(ContextEpochNumber)(0),
                source: { kind, ref },
                contentHash,
              },
              {
                executionId,
                workerId: context.workerId as string,
                workerIncarnationId: context.workerIncarnationId as string,
                fencingGeneration: context.fencingGeneration as never,
              },
            ),
          );
        const priorAssistant = {
          _tag: "AssistantMessage",
          providerTurnId: priorTurnId,
          contentRef: `provider:${priorTurnId}:assistant`,
          text: "Prior Work execution remains in history.",
          finishReason: "ToolCall",
        };
        yield* append(
          priorAssistant,
          "ProviderTurn",
          `${priorTurnId}:assistant`,
          sha256Hex(
            JSON.stringify({
              text: priorAssistant.text,
              finishReason: priorAssistant.finishReason,
            }),
          ),
        );
        const priorReasoningPayload = {
          _tag: "AttachmentRef",
          ref: "blob:prior-execution-reasoning",
          mediaType: PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
          trust: "DataOnly",
          providerTurnId: priorTurnId,
        };
        yield* append(
          priorReasoningPayload,
          "ProviderTurnReasoning",
          `${priorTurnId}:reasoning`,
        );
        const priorCallRef = "call_prior_execution";
        const priorToolCall = {
          _tag: "ToolCall",
          callRef: priorCallRef,
          toolRef: "read",
          argumentsRef: "inline:prior",
          argumentsJson: "{}",
        };
        yield* append(
          priorToolCall,
          "ProviderTurnCall",
          `${priorTurnId}:${priorCallRef}`,
        );
        const priorToolResult = {
          _tag: "ToolResult",
          callRef: priorCallRef,
          toolName: "read",
          status: "Succeeded",
          observationRef: "observation_prior_execution",
          modelOutputRef: "result_prior_execution",
          outputText: "Prior execution tool result stays paired.",
          truncated: false,
          artifactRefs: [],
        };
        yield* append(
          priorToolResult,
          "AgentLoopAction",
          "observation_prior_execution",
        );
        const priorPlainAssistant = {
          _tag: "AssistantMessage",
          providerTurnId: priorPlainTurnId,
          contentRef: `provider:${priorPlainTurnId}:assistant`,
          text: "Prior plain assistant output remains in history.",
          finishReason: "Stop",
        };
        yield* append(
          priorPlainAssistant,
          "ProviderTurn",
          `${priorPlainTurnId}:assistant`,
          sha256Hex(
            JSON.stringify({
              text: priorPlainAssistant.text,
              finishReason: priorPlainAssistant.finishReason,
            }),
          ),
        );
        const outputWrite = {
          item: {
            _tag: "AssistantMessage" as const,
            providerTurnId: outputTurnId,
            contentRef: `provider:${outputTurnId}:assistant`,
            text: outputText,
            finishReason: "ToolCall",
          },
          contextEpoch: parse(ContextEpochNumber)(0),
          source: { kind: "ProviderTurn", ref: sourceRef },
          contentHash: sha256Hex(
            JSON.stringify({ text: outputText, finishReason: "ToolCall" }),
          ),
        };
        const fence = {
          executionId,
          workerId: context.workerId as string,
          workerIncarnationId: context.workerIncarnationId as string,
          fencingGeneration: context.fencingGeneration as never,
        };
        const firstAppend = yield* tx.transact(
          sessions.appendItemIdempotent(sessionId, outputWrite, fence),
        );
        const replayAppend = yield* tx.transact(
          sessions.appendItemIdempotent(sessionId, outputWrite, fence),
        );
        const currentReasoningPayload = {
          ...priorReasoningPayload,
          ref: "blob:current-execution-reasoning",
          providerTurnId: outputTurnId,
        };
        yield* append(
          currentReasoningPayload,
          "ProviderTurnReasoning",
          `${outputTurnId}:reasoning`,
        );
        const currentCallRef = "call_current_execution";
        yield* append(
          {
            _tag: "ToolCall",
            callRef: currentCallRef,
            toolRef: "read",
            argumentsRef: "inline:current",
            argumentsJson: "{}",
          },
          "ProviderTurnCall",
          `${outputTurnId}:${currentCallRef}`,
        );
        yield* append(
          {
            _tag: "ToolResult",
            callRef: currentCallRef,
            toolName: "read",
            status: "Succeeded",
            observationRef: `observation_${executionId}_current`,
            modelOutputRef: "result_current_execution",
            outputText: "Current execution tool result stays paired.",
            truncated: false,
            artifactRefs: [],
          },
          "AgentLoopAction",
          `observation_${executionId}_current`,
        );

        const frontier = yield* tx.transact(
          sessions.listWorkActiveFrontier(sessionId, executionId),
        );
        const reasoningBlobs = new Map([
          [
            "blob:prior-execution-reasoning",
            encodeReasoningAttachment(priorReasoning),
          ],
          [
            "blob:current-execution-reasoning",
            encodeReasoningAttachment(currentReasoning),
          ],
        ]);
        const projection = projectSessionTimeline(
          frontier,
          bindingFingerprint,
          false,
          reasoningBinding,
          reasoningBlobs,
        );
        const modelContext = yield* ModelContext;
        const preparation = yield* modelContext.prepareTurn({
          executionId,
          sessionId,
          contextEpoch: parse(ContextEpochNumber)(0),
          providerTurnId: providerTurnInferenceId(executionId, 1),
          binding: { _tag: "WorkspaceExecution", workspaceId } as never,
          workspaceId,
          cognitiveMode: "execute",
          program: {
            programId: "s4-context-projection-test",
            revision: 1,
            hash: "s4-context-projection-test",
            family: "WorkExecutionProgram",
            slots: [],
            outputContractRefs: [],
            evalSetRef: "s4-context-projection-test",
          },
          fragments: [],
          contextFragments: [],
          budget: {
            modelWindow: 8000,
            outputReserve: 512,
            protocolReserve: 100,
            toolReserve: 100,
          },
          controlBasis: {
            projectPolicyRevision: 0,
            workspacePolicyRevision: 0,
            responsibilityRevision: 0,
            resourceBoundaryRevision: 0,
            authorizationDigest: "s4-context-projection-test",
            environmentRevision: "s4-context-projection-test",
          },
          maxOutputTokens: 512,
          bodySkillIds: [],
          turnProfile: {
            purpose: "WorkspaceWork",
            profileVersion: "turn-profile-v1",
            outputContractRef: "tool-invocation-v1",
            executableTools: [],
            controlTools: [],
            contextPolicyRef: "s4-context-projection-test",
            fingerprint: "s4-context-projection-test",
          },
          inputItems: projection.inputItems,
          messageContextRefs: projection.contextRefs,
          stepContext: {
            logicalStepNo: 1,
            repairAttempt: 0,
            inputFrontier: projection.frontier,
            fingerprint: "s4-context-projection-test",
            bindingFingerprint: "s4-context-projection-test",
          },
        });
        return {
          frontier,
          projection,
          preparation,
          sourceRef,
          outputText,
          firstAppend,
          replayAppend,
          priorCallRef,
          currentReasoning,
          priorReasoning,
        };
      }),
      app,
    );

    expect(prepared.frontier).toHaveLength(5);
    expect(prepared.firstAppend.inserted).toBe(true);
    expect(prepared.replayAppend).toMatchObject({
      inserted: false,
      sequence: prepared.firstAppend.sequence,
    });
    expect(prepared.projection.contextRefs).toContain(
      `session:ProviderTurn:${prepared.sourceRef}`,
    );
    expect(prepared.projection.contextRefs).not.toContain(
      "session:ProviderTurnCall:ptn_exe_018f2b3c-4d5e-7abc-8def-0123456789a9_0:call_prior_execution",
    );
    expect(prepared.projection.contextRefs).not.toContain(
      "session:ProviderTurnReasoning:ptn_exe_018f2b3c-4d5e-7abc-8def-0123456789a9_0:reasoning",
    );
    expect(prepared.projection.contextRefs).not.toContain(
      "session:ProviderTurnCall:ptn_exe_018f2b3c-4d5e-7abc-8def-0123456789a9_0:call_prior_execution",
    );
    expect(prepared.projection.contextRefs).not.toContain(
      "session:AgentLoopAction:observation_prior_execution",
    );
    expect(prepared.preparation._tag).toBe("Ready");
    if (prepared.preparation._tag !== "Ready") return;
    const requestItems = portableInputItems(prepared.preparation.turn.request);
    expect(requestItems).toContainEqual({
      _tag: "Message",
      role: "assistant",
      text: "Prior plain assistant output remains in history.",
    });
    expect(requestItems).not.toContainEqual(
      expect.objectContaining({
        _tag: "Message",
        text: "Prior Work execution remains in history.",
      }),
    );
    expect(requestItems).not.toContainEqual(
      expect.objectContaining({ callRef: prepared.priorCallRef }),
    );
    expect(requestItems).toContainEqual({
      _tag: "Message",
      role: "assistant",
      text: prepared.outputText,
    });
    expect(requestItems).toContainEqual(
      expect.objectContaining({
        _tag: "ReasoningAttachment",
        opaquePayload: "CURRENT EXECUTION REASONING IS ALLOWED",
      }),
    );
    expect(requestItems).toContainEqual(
      expect.objectContaining({
        _tag: "ToolCall",
        callRef: "call_current_execution",
        toolName: "read",
      }),
    );
    expect(requestItems).toContainEqual(
      expect.objectContaining({
        _tag: "ToolResult",
        callRef: "call_current_execution",
        outputText: "Current execution tool result stays paired.",
      }),
    );
    expect(requestItems).not.toContainEqual(
      expect.objectContaining({
        _tag: "ReasoningAttachment",
        opaquePayload: "OLD EXECUTION REASONING MUST NOT BE SENT",
      }),
    );
    expect(prepared.preparation.turn.manifest.contextRefs).toContain(
      prepared.projection.contextRefs[0],
    );
  });
  it("honors the real 64-row Work frontier and exact post-checkpoint suffix", async () => {
    const app = makeApp([textTurn]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sessions = yield* SessionRepository;
        const tx = yield* TransactionPort;
        const fence = {
          executionId,
          workerId: context.workerId as string,
          workerIncarnationId: context.workerIncarnationId as string,
          fencingGeneration: context.fencingGeneration as never,
        };
        const epoch0 = parse(ContextEpochNumber)(0);
        const appendAssistant = (
          step: number,
          contextEpoch: ContextEpochNumber,
        ) => {
          const providerTurnId = providerTurnInferenceId(executionId, step);
          const text = `assistant-output-${step}`;
          return tx.transact(
            sessions.appendItemIdempotent(
              sessionId,
              {
                item: {
                  _tag: "AssistantMessage" as const,
                  providerTurnId,
                  contentRef: `provider:${providerTurnId}:assistant`,
                  text,
                  finishReason: "Stop",
                },
                contextEpoch,
                source: {
                  kind: "ProviderTurn",
                  ref: `${providerTurnId}:assistant`,
                },
                contentHash: sha256Hex(
                  JSON.stringify({ text, finishReason: "Stop" }),
                ),
              },
              fence,
            ),
          );
        };
        for (let step = 0; step < 66; step += 1) {
          yield* appendAssistant(step, epoch0);
        }
        const preCheckpoint = yield* tx.transact(
          sessions.listWorkActiveFrontier(sessionId),
        );
        const preProjection = projectSessionTimeline(preCheckpoint);

        const epoch1 = parse(ContextEpochNumber)(1);
        const checkpoint = {
          _tag: "CompactionCheckpoint" as const,
          implementation: "Summary" as const,
          fromEpoch: epoch0,
          toEpoch: epoch1,
          retainedFrontierRef: "session-frontier:1-66",
          summaryRef: "a".repeat(64),
          summaryText: "Covered: assistant-output-2 and assistant-output-65.",
          bindingFingerprint: null,
        };
        const checkpointCommit = yield* tx.transact(
          sessions.commitCompaction(
            sessionId,
            {
              expectedEpoch: epoch0,
              nextEpoch: epoch1,
              checkpoint,
              source: { kind: "CompactionTurn", ref: "s4-frontier-checkpoint" },
              contentHash: sha256Hex(JSON.stringify(checkpoint)),
            },
            fence,
          ),
        );
        yield* appendAssistant(66, epoch1);
        const postCheckpoint = yield* tx.transact(
          sessions.listWorkActiveFrontier(sessionId),
        );
        const postProjection = projectSessionTimeline(postCheckpoint);
        return {
          preCheckpoint,
          preProjection,
          checkpointCommit,
          postCheckpoint,
          postProjection,
        };
      }),
      app,
    );

    expect(result.preCheckpoint).toHaveLength(64);
    expect(result.preCheckpoint[0]?.sequence).toBe(2);
    expect(result.preCheckpoint.at(-1)?.sequence).toBe(65);
    expect(result.preProjection.inputItems).toHaveLength(64);
    expect(result.preProjection.inputItems).not.toContainEqual(
      expect.objectContaining({ text: "assistant-output-0" }),
    );
    expect(result.preProjection.inputItems).not.toContainEqual(
      expect.objectContaining({ text: "assistant-output-1" }),
    );
    expect(result.preProjection.inputItems).toContainEqual(
      expect.objectContaining({ text: "assistant-output-2" }),
    );
    expect(result.preProjection.inputItems).toContainEqual(
      expect.objectContaining({ text: "assistant-output-65" }),
    );
    expect(result.postCheckpoint.map((entry) => entry.sequence)).toEqual([
      result.checkpointCommit.sequence,
      result.checkpointCommit.sequence + 1,
    ]);
    expect(result.postProjection.inputItems).toEqual([
      {
        _tag: "Message",
        role: "system",
        text: "[Continuation checkpoint]\nCovered: assistant-output-2 and assistant-output-65.",
      },
      {
        _tag: "Message",
        role: "assistant",
        text: "assistant-output-66",
      },
    ]);
  });
  it("uses the terminal attempt classification for an ordinary failure under P19", async () => {
    const app = makeApp([], { providerFailures: ["RequestRejected"] });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const settlement = yield* Effect.exit(drive(allowGate));
        const sql = yield* SqlClient;
        const steps = yield* sql.unsafe<{ state: string }>(
          "SELECT state FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        return { settlement, step: steps[0] };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "Failed",
        failure: {
          _tag: "ExecutionFailure",
          reason: "ProviderFailure:RequestRejected",
        },
      },
    });
    expect(result.step?.state).toBe("SettlementProposed");
  });
});
