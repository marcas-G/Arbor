import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import type { AgentActionHandler } from "../../packages/agent-runtime/src/index.js";
import {
  CommandId,
  type CommandSubmissionContext,
  type Execution,
  ExecutionId,
  parse,
  providerTurnInferenceId,
} from "../../packages/domain/dist/index.js";
import {
  ConversationAttemptStore,
  ConversationResponseJobStore,
  HumanMessageStore,
  type PortableModelRequest,
  ProviderRuntime,
  portableInputItems,
  type RuntimeSafetyGateService,
  sha256Hex,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";
import { createCurrentSchemaTestDatabase } from "../support/schema44-database.js";

import {
  allowGate,
  context,
  drive,
  execution,
  executionId,
  makeApp,
  principal,
  projectId,
  run,
  sessionId,
  textTurn,
  workspaceId,
} from "./support.js";

const conversationExecution = (messageId: string): Execution => ({
  ...execution,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    episode: {
      _tag: "ConversationResponseEpisode",
      messageId: messageId as never,
      responseJobRevision: 0,
    },
  },
});
const currentConversationContext: CommandSubmissionContext = {
  ...context,
  workerIncarnationId: "incarnation:p3-current-conversation",
};
const seedCurrentConversation = (input: {
  readonly messageId: string;
  readonly body: string;
  readonly commandId: CommandId;
  readonly fingerprint: string;
  readonly includeForeignWorkAssistant?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
    const humanMessages = yield* HumanMessageStore;
    const jobs = yield* ConversationResponseJobStore;
    const attempts = yield* ConversationAttemptStore;
    const primarySessionId =
      "ses_018f2b3c-4d5e-7abc-8def-0123456789ab" as never;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `INSERT INTO projects (
             project_id, name, root_workspace_id, project_policy,
             project_policy_revision, default_configuration, environment_ref,
             lifecycle, revision, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            projectId,
            "P3 current Conversation",
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
        yield* ensureLegacyProjectResourceSourceFixture();
        yield* sql.unsafe(
          `INSERT INTO sessions (
             session_id, binding_kind, workspace_id, execution_id,
             context_epoch, created_at
           ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't'),
                    (?, 'ExecutionScoped', NULL, ?, 0, 't')`,
          [primarySessionId, workspaceId, sessionId, executionId],
        );
        yield* sql.unsafe(
          `INSERT INTO workspaces (
             workspace_id, project_id, parent_workspace_id, name,
             responsibility_definition, responsibility_revision,
             resource_boundary, resource_boundary_revision, agent_binding,
             primary_session_id, current_work_id, workspace_policy,
             workspace_policy_revision, revision, lifecycle, created_at, updated_at
           ) VALUES (?, ?, NULL, ?, '{}', 0, '{}', 0, '{}', ?, NULL,
                     '{}', 0, 0, 'Active', 't', 't')`,
          [workspaceId, projectId, "P3 current Conversation", primarySessionId],
        );
        yield* sql.unsafe(
          `INSERT INTO executions (
             execution_id, project_id, binding_kind, workspace_id,
             episode_kind, episode_ref, episode_revision, parent_execution_id,
             mission, session_id, admitted_at, stop_requested_at,
             settlement_kind, settlement_json, settled_at
           ) VALUES (?, ?, 'workspace', ?, 'ConversationResponseEpisode', ?, 0,
                     NULL, NULL, ?, 't', NULL, NULL, NULL, NULL)`,
          [executionId, projectId, workspaceId, input.messageId, sessionId],
        );
        if (input.includeForeignWorkAssistant === true) {
          const foreignWorkExecutionId = parse(ExecutionId)(
            "exe_00000000-0000-7000-8000-000000000117",
          );
          const foreignWorkProviderTurnId = providerTurnInferenceId(
            foreignWorkExecutionId,
            0,
          );
          const foreignText = "WORK SESSION OUTPUT MUST NOT ENTER CHAT";
          const payload = {
            _tag: "AssistantMessage",
            providerTurnId: foreignWorkProviderTurnId,
            contentRef: `provider:${foreignWorkProviderTurnId}:assistant`,
            text: foreignText,
            finishReason: "Stop",
          };
          yield* sql.unsafe(
            `INSERT INTO session_entries (
               session_id, sequence, entry_kind, item_type, schema_version,
               context_epoch, payload_json, created_at, source_kind, source_ref,
               content_hash
             ) VALUES (?, 0, 'ModelOutput', 'AssistantMessage', 2, 0, ?, 't',
                       'ProviderTurn', ?, ?)`,
            [
              sessionId,
              JSON.stringify(payload),
              `${foreignWorkProviderTurnId}:assistant`,
              sha256Hex(
                JSON.stringify({ text: foreignText, finishReason: "Stop" }),
              ),
            ],
          );
        }
        yield* sql.unsafe(
          `INSERT INTO execution_leases (
             execution_id, worker_id, worker_incarnation_id, generation,
             expires_at, updated_at
           ) VALUES (?, ?, ?, 0, '9999-12-31T00:00:00.000Z', 't')`,
          [
            executionId,
            currentConversationContext.workerId,
            currentConversationContext.workerIncarnationId,
          ],
        );
      }),
    );
    yield* tx.transact(
      Effect.gen(function* () {
        yield* humanMessages.insertPending({
          messageId: input.messageId,
          projectId,
          rootWorkspaceId: workspaceId,
          humanPrincipal: principal,
          bodyRef: input.body,
          commandId: input.commandId,
          fingerprint: input.fingerprint,
          state: "Pending",
          claimedByExecutionId: null,
          createdAt: "t",
          settledAt: null,
          responseBody: null,
          providerReasoning: null,
          attemptNo: 0,
        });
        yield* jobs.insert({
          messageId: input.messageId as never,
          projectId,
          rootWorkspaceId: workspaceId,
          state: { _tag: "Running", attemptNo: 0, executionId },
          nextAttemptNo: 1,
          policyVersion: "conversation-retry-v1",
          providerReasoning: null,
          lastFailureClass: null,
          revision: 1,
          createdAt: "t",
          updatedAt: "t",
        });
        yield* attempts.insert({
          messageId: input.messageId as never,
          attemptNo: 0,
          executionId,
          admittedAt: "t",
          settledAt: null,
          settlementKind: null,
          failureClass: null,
          failureFingerprint: null,
          retryDecision: null,
          policyVersion: "conversation-retry-v1",
        });
      }),
    );
  });
const withCurrentSchema48 = async <A>(
  body: (databaseFilename: string) => Promise<A>,
): Promise<A> => {
  const fixture = await createCurrentSchemaTestDatabase();
  try {
    return await body(fixture.databaseFilename);
  } finally {
    fixture.cleanup();
  }
};
const proposeWorkspaceTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "proposal-call",
    toolName: "propose_workspace",
    argumentsJson: JSON.stringify({
      name: "research-child",
      rationale: "independent long-lived research responsibility",
      responsibilityDraft: {
        purpose: "own the research stream",
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      resourceBoundaryDraft: {
        addresses: [{ _tag: "FileTree", path: "." }],
      },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];
describe("P3-013 agent driver", () => {
  it("carries a conversation-safe control result into the next turn before answering", async () => {
    const requests: PortableModelRequest[] = [];
    const progressAtProviderBoundary: Array<boolean | undefined> = [];
    const gate: RuntimeSafetyGateService = {
      admitActivity: (_executionId, activity, observation) => {
        if (
          activity._tag === "ProviderTurn" &&
          observation?.inFlight !== "end"
        ) {
          progressAtProviderBoundary.push(observation?.durableProgress);
        }
        return Effect.succeed("Continue" as const);
      },
    };
    const observationMarker = "ProposalRecorded(fpr_test); awaiting approval";
    let call = 0;
    const proposalHandler: AgentActionHandler = {
      action: "ProposeChildWorkspace",
      handle: () =>
        Effect.succeed({
          _tag: "Observation",
          source: "Runtime",
          observation: { text: observationMarker, truncated: false },
        }),
    };
    const messageId = "msg_018f2b3c-4d5e-7abc-8def-0123456789a4";
    const settlement = await withCurrentSchema48((databaseFilename) => {
      const app = makeApp([], {
        controlHandlers: [proposalHandler],
        databaseFilename,
        providerRuntime: Layer.succeed(ProviderRuntime, {
          runTurn: (input) => {
            requests.push(input.request);
            const events = call === 0 ? proposeWorkspaceTurn : textTurn;
            call += 1;
            return Effect.succeed({
              events: [
                {
                  _tag: "TurnStarted",
                  providerTurnId: input.providerTurnId,
                  attemptNo: 0,
                  modelRef: input.request.modelRef,
                },
                ...events,
              ],
              attemptNo: 0,
              retryDecisions: [],
            });
          },
        }),
      });
      return run(
        Effect.gen(function* () {
          yield* seedCurrentConversation({
            messageId,
            body: "创建子工作区",
            commandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789a4",
            ),
            fingerprint: "fp-conversation-action",
            includeForeignWorkAssistant: true,
          });
          return yield* drive(
            gate,
            currentConversationContext,
            conversationExecution(messageId),
          );
        }),
        app,
      );
    });

    expect(settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "ConversationResponseProduced", messageId },
    });
    expect(requests).toHaveLength(2);
    expect(progressAtProviderBoundary).toEqual([false, true]);
    expect(
      requests.flatMap((request) => portableInputItems(request)),
    ).not.toContainEqual(
      expect.objectContaining({
        _tag: "Message",
        role: "assistant",
        text: "WORK SESSION OUTPUT MUST NOT ENTER CHAT",
      }),
    );
    expect(
      requests.flatMap((request) => portableInputItems(request)),
    ).not.toContainEqual(
      expect.objectContaining({
        _tag: "Message",
        role: "assistant",
        text: "WORK SESSION OUTPUT MUST NOT ENTER CHAT",
      }),
    );
    expect(
      requests[1] === undefined ? [] : portableInputItems(requests[1]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: "ControlResult",
          outputText: observationMarker,
        }),
      ]),
    );
  }, 60_000);
  it("replays a settled Provider result after the first sourced Session handoff is fenced", async () => {
    const result = await withCurrentSchema48((databaseFilename) => {
      const app = makeApp([textTurn], {
        databaseFilename,
        failFirstSourcedAppend: true,
      });
      const program = Effect.gen(function* () {
        yield* seedCurrentConversation({
          messageId: "msg_018f2b3c-4d5e-7abc-8def-0123456789a1",
          body: "hello",
          commandId: parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
          ),
          fingerprint: "fp",
        });
        const sql = yield* SqlClient;
        const exactExecution = conversationExecution(
          "msg_018f2b3c-4d5e-7abc-8def-0123456789a1",
        );
        const first = yield* Effect.exit(
          drive(allowGate, currentConversationContext, exactExecution),
        );
        const replayProviderAdmissions: Array<string> = [];
        const replayGate: RuntimeSafetyGateService = {
          admitActivity: (_executionId, activity, observation) => {
            if (
              activity._tag === "ProviderTurn" &&
              observation?.inFlight !== "end"
            ) {
              replayProviderAdmissions.push(activity.fingerprint);
            }
            return Effect.succeed("Continue" as const);
          },
        };
        const second = yield* drive(
          replayGate,
          currentConversationContext,
          exactExecution,
        );
        const attempts = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM provider_attempts",
        );
        const outputs = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn' AND entry_kind = 'ModelOutput'",
        );
        const steps = yield* sql.unsafe<{ state: string }>(
          "SELECT state FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        return {
          first,
          second,
          attemptCount: Number(attempts[0]?.count ?? 0),
          outputCount: Number(outputs[0]?.count ?? 0),
          stepState: steps[0]?.state,
          replayProviderAdmissions,
        };
      });
      return run(program, app);
    });
    expect(result.first._tag).toBe("Failure");
    expect(result.second).toMatchObject({
      _tag: "Completed",
      result: { _tag: "ConversationResponseProduced" },
    });
    expect(result.attemptCount).toBe(1);
    expect(result.outputCount).toBe(1);
    expect(result.stepState).toBe("SettlementProposed");
    expect(result.replayProviderAdmissions).toEqual([]);
  });
  it("rolls back the sourced answer when the OutputAccepted step transition is interrupted", async () => {
    const result = await withCurrentSchema48((databaseFilename) => {
      const app = makeApp([textTurn], {
        databaseFilename,
        failFirstOutputAcceptedTransition: true,
      });
      const program = Effect.gen(function* () {
        yield* seedCurrentConversation({
          messageId: "msg_018f2b3c-4d5e-7abc-8def-0123456789a3",
          body: "atomic handoff",
          commandId: parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789a3",
          ),
          fingerprint: "fp-atomic",
        });
        const sql = yield* SqlClient;
        const exactExecution = conversationExecution(
          "msg_018f2b3c-4d5e-7abc-8def-0123456789a3",
        );
        const first = yield* Effect.exit(
          drive(allowGate, currentConversationContext, exactExecution),
        );
        const afterFirst = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn'",
        );
        const second = yield* drive(
          allowGate,
          currentConversationContext,
          exactExecution,
        );
        const afterSecond = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn'",
        );
        const attempts = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM provider_attempts",
        );
        return {
          first,
          afterFirst: Number(afterFirst[0]?.count ?? 0),
          second,
          afterSecond: Number(afterSecond[0]?.count ?? 0),
          attempts: Number(attempts[0]?.count ?? 0),
        };
      });
      return run(program, app);
    });
    expect(result.first._tag).toBe("Failure");
    expect(result.afterFirst).toBe(0);
    expect(result.second._tag).toBe("Completed");
    expect(result.afterSecond).toBe(1);
    expect(result.attempts).toBe(1);
  });
  it("adopts equivalent schema-48 legacy settled no-action evidence without another Provider request", async () => {
    const messageId = "msg_018f2b3c-4d5e-7abc-8def-0123456789a2";
    const providerTurnId = `ptn_${executionId}_0`;
    const result = await withCurrentSchema48((databaseFilename) => {
      const app = makeApp([textTurn], {
        databaseFilename,
        failFirstSourcedAppend: true,
      });
      const program = Effect.gen(function* () {
        yield* seedCurrentConversation({
          messageId,
          body: "legacy hello",
          commandId: parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
          ),
          fingerprint: "fp-legacy",
        });
        const sql = yield* SqlClient;
        const exactExecution = conversationExecution(messageId);
        const first = yield* Effect.exit(
          drive(allowGate, currentConversationContext, exactExecution),
        );
        // Recreate the durable pre-AH1 success-evidence state on the current
        // schema, without starting runtime against an older database prefix.
        yield* sql.unsafe(
          "UPDATE provider_attempts SET success_evidence_version = NULL WHERE provider_turn_id = ? AND attempt_no = 0",
          [providerTurnId],
        );
        yield* sql.unsafe(
          `UPDATE agent_loop_steps SET state = 'Prepared',
             migration_provenance_json = NULL
           WHERE execution_id = ? AND logical_step_no = 0 AND repair_attempt = 0`,
          [executionId],
        );
        const second = yield* drive(
          allowGate,
          currentConversationContext,
          exactExecution,
        );
        const attempts = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM provider_attempts",
        );
        const outputs = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn' AND entry_kind = 'ModelOutput'",
        );
        const steps = yield* sql.unsafe<{
          state: string;
          migration_provenance_json: string | null;
        }>(
          "SELECT state, migration_provenance_json FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        const evidence = yield* sql.unsafe<{
          success_evidence_version: string | null;
        }>(
          "SELECT success_evidence_version FROM provider_attempts WHERE provider_turn_id = ?",
          [providerTurnId],
        );
        return {
          first,
          second,
          attemptCount: Number(attempts[0]?.count ?? 0),
          outputCount: Number(outputs[0]?.count ?? 0),
          step: steps[0],
          evidenceVersion: evidence[0]?.success_evidence_version,
        };
      });
      return run(program, app);
    });
    expect(result.first._tag).toBe("Failure");
    expect(result.second).toMatchObject({
      _tag: "Completed",
      result: { _tag: "ConversationResponseProduced" },
    });
    expect(result.attemptCount).toBe(1);
    expect(result.outputCount).toBe(1);
    expect(result.step?.state).toBe("SettlementProposed");
    expect(result.step?.migration_provenance_json).toContain(
      "LegacySettledProviderSuccess",
    );
    expect(result.evidenceVersion).toBe("provider-success-v1");
  });
});
