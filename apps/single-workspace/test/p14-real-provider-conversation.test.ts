import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import type { ModelCatalog } from "@arbor/model-context";
import {
  HumanMessageStore,
  type PortableModelRequest,
  portableInputItems,
  secretRef,
} from "@arbor/ports";
import {
  OpenAICompatibleFetchClient,
  type OpenAISdkChunk,
  type OpenAISdkClient,
} from "@arbor/provider-openai";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  ProductionDaemonService,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ac");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ac");
const priorHumanQuestion = "我之前说过这次修复的代号是什么？";
const priorAssistantAnswer = "这次修复的代号是蓝松。";
const humanQuestion = "请说明仓库根目录有哪些主要模块，并给出两条验证建议。";
const assistantAnswer =
  "根目录包含 apps、packages 和 adapters。建议先运行 pnpm check，再针对目标包运行 focused tests。";
const liveHumanInputSentinelEnabled =
  process.env.ARBOR_WAVE1_LIVE_HUMAN_INPUT === "1";

describe("P14 production conversation model context", () => {
  it(
    "places the current claimed Human Input in the production ProviderTurn request",
    async () => {
      const liveHumanInput = liveHumanInputSentinelEnabled;
      const liveBaseUrl = process.env.ARBOR_OPENAI_BASE_URL?.trim();
      const liveModelRef = process.env.ARBOR_LLM_MODEL?.trim();
      if (
        liveHumanInput &&
        (liveBaseUrl === undefined ||
          liveBaseUrl.length === 0 ||
          liveModelRef === undefined ||
          liveModelRef.length === 0)
      ) {
        throw new Error(
          "ARBOR_OPENAI_BASE_URL and ARBOR_LLM_MODEL are required for the live Human Input sentinel",
        );
      }
      const dir = mkdtempSync(join(tmpdir(), "wave1-human-input-"));
      const databaseFile = join(dir, "slice.db");
      const currentHumanQuestion = liveHumanInput
        ? "Reply with exactly WAVE1_CURRENT_HUMAN_INPUT_RECEIVED as plain text. Do not emit a tool or function call."
        : humanQuestion;
      let portableRequest: PortableModelRequest | undefined;
      let observedRequest: Record<string, unknown> | undefined;
      let actualWireRequest: Record<string, unknown> | undefined;
      let manifestAtProviderCall: Record<string, unknown> | undefined;
      const providerEvents: OpenAISdkChunk[] = [];
      const responseText = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: assistantAnswer }, finish_reason: null }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n");
      const responseBytes = new TextEncoder().encode(responseText);
      const modelRef = liveHumanInput
        ? (liveModelRef as string)
        : "wave1-human-model";
      const humanEvidenceFile = process.env.ARBOR_WAVE1_HUMAN_EVIDENCE_FILE;
      const writeLiveEvidence = (
        status: string,
        humanMessageState: string | null = null,
        responseBody: string | null = null,
      ): void => {
        if (!liveHumanInput || humanEvidenceFile === undefined) {
          return;
        }
        writeFileSync(
          humanEvidenceFile,
          JSON.stringify(
            {
              schemaVersion: "wave1-live-human-input-evidence-v1",
              recordedAt: new Date().toISOString(),
              status,
              productionCallPath: [
                "apps/single-workspace ProductionDaemonService.conversationTick",
                "execution-runtime.runExecution worker/lease lifecycle",
                "ExecutionDriverPort -> agent-runtime AgentLoopDriverLive",
                "ModelContext.prepareTurn with current claimed Human Input",
                "ProviderRuntime.runTurn",
                "OpenAIProviderLive -> OpenAICompatibleFetchClient -> live endpoint",
              ],
              provider: {
                adapterId: "provider-openai",
                endpoint: liveBaseUrl,
                modelRef,
                authMode:
                  process.env.ARBOR_OPENAI_AUTH ?? "configured externally",
              },
              actualPortableModelRequest: portableRequest ?? null,
              actualWireRequest: actualWireRequest ?? null,
              providerTurnId: manifestAtProviderCall?.providerTurnId ?? null,
              manifestDurableAtProviderCall: manifestAtProviderCall ?? null,
              providerEvents,
              humanMessageState,
              responseBody,
            },
            null,
            2,
          ),
        );
      };
      const modelCatalog: ModelCatalog = {
        defaultModelRef: modelRef,
        entries: [
          {
            modelRef,
            adapterId: "provider-openai",
            capability: {
              modelRef,
              family: "openai-compatible",
              contextWindow: 8_192,
              outputCeiling: 512,
              toolProtocol: "json",
              capabilities: ["text", "tools"],
            },
          },
        ],
      };
      const transport = OpenAICompatibleFetchClient({
        baseUrl: liveHumanInput
          ? (liveBaseUrl as string)
          : "http://wave1-human-provider.test/v1",
        allowUnauthenticated:
          process.env.ARBOR_OPENAI_AUTH === "none" || !liveHumanInput,
        fetch: async (url, init) => {
          observedRequest = JSON.parse(init.body) as Record<string, unknown>;
          if (liveHumanInput) {
            actualWireRequest = observedRequest;
            writeLiveEvidence("ProviderCallIssued");
            return globalThis.fetch(url, init as RequestInit);
          }
          return {
            ok: true,
            status: 200,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(responseBytes);
                controller.close();
              },
            }),
          };
        },
      });
      const client: OpenAISdkClient = {
        externalEffectPossible: false,
        streamChat: async function* (input) {
          portableRequest = input.request;
          const providerTurnId = input.context.providerTurnId;
          const database = new DatabaseSync(databaseFile);
          try {
            const row = database
              .prepare(
                "SELECT manifest_json, compiled_request_hash FROM model_context_manifests WHERE provider_turn_id = ?",
              )
              .get(providerTurnId) as
              | {
                  readonly manifest_json: string;
                  readonly compiled_request_hash: string;
                }
              | undefined;
            manifestAtProviderCall =
              row === undefined
                ? undefined
                : {
                    providerTurnId,
                    ...(JSON.parse(row.manifest_json) as Record<
                      string,
                      unknown
                    >),
                    durableCompiledRequestHash: row.compiled_request_hash,
                  };
          } finally {
            database.close();
          }
          for await (const event of transport.streamChat(input)) {
            if (event.type !== "reasoning") {
              providerEvents.push(event);
            }
            yield event;
          }
        },
      };
      const app = buildSingleWorkspaceLayer({
        databaseFile,
        projectId,
        modelCatalog,
        modelRef,
        provider: { adapterId: "provider-openai", client },
      });

      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(CURRENT_MIGRATIONS);
            const sql = yield* SqlClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(
                  "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  [
                    projectId,
                    "Wave 1 Human Input project",
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
                    "root",
                    JSON.stringify({
                      purpose: "Answer the current human input.",
                      ownedResponsibilities: [],
                      obligations: [],
                      includes: [],
                      excludes: [],
                      interfaces: [],
                    }),
                    0,
                    JSON.stringify({ addresses: [] }),
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
                yield* sql.unsafe(
                  "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no) VALUES (?,?,?,?,?,?,?,'Pending',NULL,?,NULL,NULL,0)",
                  [
                    "msg_wave1_018f2b3c-4d5e-7abc-8def-0123456789ac",
                    projectId,
                    workspaceId,
                    parse(Principal)("user:integration-test"),
                    currentHumanQuestion,
                    "cmd_wave1_018f2b3c-4d5e-7abc-8def-0123456789ac",
                    "wave1-human-fingerprint",
                    "2026-09-26T00:00:00.000Z",
                  ],
                );
                yield* sql.unsafe(
                  "INSERT INTO conversation_response_jobs (message_id, project_id, root_workspace_id, state, active_execution_id, next_attempt_no, next_eligible_at, attention_reason, last_failure_class, last_failure_fingerprint, policy_version, response_body, response_execution_id, provider_reasoning_json, revision, created_at, updated_at) VALUES (?,?,?,'Queued',NULL,0,NULL,NULL,NULL,NULL,'conversation-retry-v1',NULL,NULL,NULL,0,?,?)",
                  [
                    "msg_wave1_018f2b3c-4d5e-7abc-8def-0123456789ac",
                    projectId,
                    workspaceId,
                    "2026-09-26T00:00:00.000Z",
                    "2026-09-26T00:00:00.000Z",
                  ],
                );
              }),
            );

            const daemon = yield* ProductionDaemonService;
            yield* daemon.daemon.conversationTick;
            yield* daemon.daemon.conversationTick;

            const manifests = yield* sql.unsafe<{
              manifest_json: string;
              compiled_request_hash: string;
            }>(
              "SELECT manifest_json, compiled_request_hash FROM model_context_manifests",
            );
            const messages = yield* sql.unsafe<{
              state: string;
              response_body: string | null;
            }>(
              "SELECT state, response_body FROM conversation_response_jobs WHERE message_id = ?",
              ["msg_wave1_018f2b3c-4d5e-7abc-8def-0123456789ac"],
            );
            return { manifests, message: messages[0] };
          }),
          app,
        ),
      );

      writeLiveEvidence(
        "ExecutionReturned",
        result.message?.state ?? null,
        result.message?.response_body ?? null,
      );

      expect(
        portableRequest === undefined
          ? undefined
          : portableInputItems(portableRequest).filter(
              (item) => item._tag === "Message" && item.role !== "system",
            ),
      ).toEqual([
        { _tag: "Message", role: "user", text: currentHumanQuestion },
      ]);
      expect(observedRequest?.messages).toContainEqual({
        role: "user",
        content: currentHumanQuestion,
      });
      expect(observedRequest?.model).toBe(modelRef);
      if (liveHumanInput) {
        expect(result.message?.state).toBe("Answered");
        expect(result.message?.response_body).toContain(
          "WAVE1_CURRENT_HUMAN_INPUT_RECEIVED",
        );
      } else {
        expect(result.message).toEqual({
          state: "Answered",
          response_body: assistantAnswer,
        });
      }
      const manifest = JSON.parse(
        result.manifests[0]?.manifest_json ?? "{}",
      ) as Record<string, unknown>;
      expect(manifestAtProviderCall).toMatchObject({
        providerTurnId: manifest.providerTurnId,
        compiledRequestHash: result.manifests[0]?.compiled_request_hash,
        durableCompiledRequestHash: result.manifests[0]?.compiled_request_hash,
      });
      expect(manifest).toMatchObject({
        providerRef: "provider-openai",
        modelRef,
      });
      expect(manifest.contextRefs).toContain(
        "human-input:msg_wave1_018f2b3c-4d5e-7abc-8def-0123456789ac",
      );
      expect(manifest.compiledRequestHash).toBe(
        result.manifests[0]?.compiled_request_hash,
      );
    },
    liveHumanInputSentinelEnabled ? 110_000 : 30_000,
  );

  it("sends recent answered turns with the claimed human message and persists its answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p14-provider-conversation-"));
    const secretRoot = join(dir, "secrets");
    mkdirSync(secretRoot);
    writeFileSync(join(secretRoot, "test-api-key"), "integration-test-key\n", {
      mode: 0o600,
    });

    let observedRequest: Record<string, unknown> | undefined;
    const responseText = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: assistantAnswer }, finish_reason: null }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n");
    const responseBytes = new TextEncoder().encode(responseText);

    const modelCatalog: ModelCatalog = {
      defaultModelRef: "integration-model",
      entries: [
        {
          modelRef: "integration-model",
          adapterId: "provider-openai",
          capability: {
            modelRef: "integration-model",
            family: "openai-compatible",
            contextWindow: 8_192,
            outputCeiling: 512,
            toolProtocol: "json",
            capabilities: ["text", "tools"],
          },
        },
      ],
    };
    const app = buildSingleWorkspaceLayer({
      databaseFile: join(dir, "slice.db"),
      projectId,
      modelCatalog,
      modelRef: "integration-model",
      provider: {
        adapterId: "provider-openai",
        client: OpenAICompatibleFetchClient({
          baseUrl: "http://model.test/v1",
          fetch: async (_url, init) => {
            observedRequest = JSON.parse(init.body) as Record<string, unknown>;
            return {
              ok: true,
              status: 200,
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(responseBytes);
                  controller.close();
                },
              }),
            };
          },
        }),
      },
      secretRef: secretRef("test-api-key"),
      secretStore: { _tag: "File", root: secretRoot },
    });

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [
                  projectId,
                  "Integration project",
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
                  "root",
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
              yield* sql.unsafe(
                "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no) VALUES (?,?,?,?,?,?,?,'Answered',NULL,?,?,?,0)",
                [
                  "msg_prior_018f2b3c-4d5e-7abc-8def-0123456789ac",
                  projectId,
                  workspaceId,
                  parse(Principal)("user:integration-test"),
                  priorHumanQuestion,
                  "cmd_prior_018f2b3c-4d5e-7abc-8def-0123456789ac",
                  "integration-prior-fingerprint",
                  "2026-09-24T00:00:00.000Z",
                  "2026-09-24T00:01:00.000Z",
                  priorAssistantAnswer,
                ],
              );
              yield* sql.unsafe(
                "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no) VALUES (?,?,?,?,?,?,?,'Pending',NULL,?,NULL,NULL,0)",
                [
                  "msg_018f2b3c-4d5e-7abc-8def-0123456789ac",
                  projectId,
                  workspaceId,
                  parse(Principal)("user:integration-test"),
                  humanQuestion,
                  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
                  "integration-fingerprint",
                  "2026-09-25T00:00:00.000Z",
                ],
              );
              yield* sql.unsafe(
                "INSERT INTO conversation_response_jobs (message_id, project_id, root_workspace_id, state, active_execution_id, next_attempt_no, next_eligible_at, attention_reason, last_failure_class, last_failure_fingerprint, policy_version, response_body, response_execution_id, provider_reasoning_json, revision, created_at, updated_at) VALUES (?,?,?,'Answered',NULL,1,NULL,NULL,NULL,NULL,'conversation-retry-v1',?,?,NULL,0,?,?), (?,?,?,'Queued',NULL,0,NULL,NULL,NULL,NULL,'conversation-retry-v1',NULL,NULL,NULL,0,?,?)",
                [
                  "msg_prior_018f2b3c-4d5e-7abc-8def-0123456789ac",
                  projectId,
                  workspaceId,
                  priorAssistantAnswer,
                  "exe_prior_018f2b3c-4d5e-7abc-8def-0123456789ac",
                  "2026-09-24T00:00:00.000Z",
                  "2026-09-24T00:01:00.000Z",
                  "msg_018f2b3c-4d5e-7abc-8def-0123456789ac",
                  projectId,
                  workspaceId,
                  "2026-09-25T00:00:00.000Z",
                  "2026-09-25T00:00:00.000Z",
                ],
              );
            }),
          );

          const daemon = yield* ProductionDaemonService;
          yield* HumanMessageStore;
          yield* daemon.daemon.conversationTick;
          // Settlement is a separate deterministic sweep; the second tick
          // writes the persisted response body for the transcript projection.
          yield* daemon.daemon.conversationTick;

          const messageRows = yield* sql.unsafe<{
            state: string;
            response_body: string | null;
          }>(
            "SELECT state, response_body FROM conversation_response_jobs WHERE message_id = ?",
            ["msg_018f2b3c-4d5e-7abc-8def-0123456789ac"],
          );
          const executionRows = yield* sql.unsafe<{
            settlement_json: string | null;
          }>(
            "SELECT settlement_json FROM executions WHERE workspace_id = ? AND focus_kind = 'coordination' ORDER BY admitted_at DESC LIMIT 1",
            [workspaceId],
          );
          return {
            message: messageRows[0],
            settlement: executionRows[0]?.settlement_json ?? null,
          };
        }),
        app,
      ),
    );

    const outboundMessages = observedRequest?.messages;
    expect(observedRequest?.model).toBe("integration-model");
    expect(Array.isArray(outboundMessages)).toBe(true);
    expect(outboundMessages).toContainEqual({
      role: "user",
      content: humanQuestion,
    });
    const conversationMessages = Array.isArray(outboundMessages)
      ? outboundMessages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as Record<string, unknown>).role !== "system",
        )
      : [];
    expect(conversationMessages).toEqual([
      { role: "user", content: priorHumanQuestion },
      { role: "assistant", content: priorAssistantAnswer },
      { role: "user", content: humanQuestion },
    ]);
    // Root Human Conversation is a response episode, not a Work execution.
    // Its normal output surface therefore contains no Work/formation control
    // affordances (tool-surface-review/13). In particular, exposing
    // arbor_claim_completion here lets a model select an action that the
    // runtime must reject because there is no bound Work.
    const toolNames = (
      (observedRequest?.tools ?? []) as Array<{
        function?: { name?: string };
      }>
    )
      .map((tool) => tool.function?.name)
      .sort();
    expect(toolNames).toEqual([]);
    expect(result.message).toEqual({
      state: "Answered",
      response_body: assistantAnswer,
    });
    expect(result.settlement).toContain("QueryCompleted");
  });
});
