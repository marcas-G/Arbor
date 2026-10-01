import {
  type ExecutionId,
  MessageId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  ConversationAttemptStore,
  ConversationResponseJobStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ConversationAttemptStoreLive,
  ConversationResponseJobStoreLive,
  layer,
  P21_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  runConversationResponseSettlementSweep,
  runConversationResponseTrigger,
} from "../packages/application/src/index.js";

const messageId = parse(MessageId)("msg_018f2b3c-4d5e-7abc-8def-0123456789a1");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const principal = parse(Principal)("runtime:conversation-trigger");

describe("P17 ConversationResponse runtime", () => {
  it("admits one Job attempt and sends a failed execution to Attention without retry", async () => {
    const base = layer({ filename: ":memory:" });
    const txLayer = Layer.provide(TransactionPortLive, base);
    const app = Layer.mergeAll(
      Layer.provide(ConversationResponseJobStoreLive, base),
      Layer.provide(ConversationAttemptStoreLive, base),
      txLayer,
      base,
    );
    let gatewayCalls = 0;
    let admittedExecutionId: ExecutionId | null = null;
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no, provider_reasoning_json) VALUES (?,?,?,?,?,?,?,'Pending',NULL,?,NULL,NULL,0,NULL)",
        [
          messageId,
          projectId,
          workspaceId,
          "user:test",
          "body",
          "cmd:test",
          "fp:test",
          "2026-10-01T00:00:00.000Z",
        ],
      );
      const jobs = yield* ConversationResponseJobStore;
      const attempts = yield* ConversationAttemptStore;
      const tx = yield* TransactionPort;
      yield* tx.transact(
        jobs.insert({
          messageId,
          projectId,
          rootWorkspaceId: workspaceId,
          state: { _tag: "Queued" },
          nextAttemptNo: 0,
          policyVersion: "conversation-retry-v1",
          providerReasoning: null,
          lastFailureClass: null,
          revision: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        }),
      );
      const triggerDeps = {
        gateway: {
          execute: (envelope: { payload: unknown }) => {
            gatewayCalls += 1;
            admittedExecutionId = (
              envelope.payload as { executionId: ExecutionId }
            ).executionId;
            return Effect.succeed({
              commandId: "cmd:test",
              resolution: { _tag: "Committed", result: {} },
            } as never);
          },
        },
        jobs,
        attempts,
        projects: {
          findById: () =>
            Effect.succeed(
              Option.some({
                projectId,
                rootWorkspaceId: workspaceId,
                lifecycle: "Open",
              } as never),
            ),
        },
        executions: {
          findActiveMainByWorkspace: () => Effect.succeed(Option.none()),
        },
        clock: { now: () => Effect.succeed("2026-10-01T00:00:01.000Z") },
        tx,
        principal,
      } as never;
      const admitted = yield* runConversationResponseTrigger(
        triggerDeps,
        projectId,
      );
      const running = yield* tx.transact(jobs.find(messageId));
      if (Option.isNone(running) || admittedExecutionId === null) {
        throw new Error("trigger failed to create a running job");
      }
      const sweep = yield* tx.transact(
        runConversationResponseSettlementSweep(
          {
            jobs,
            attempts,
            executions: {
              findById: () =>
                Effect.succeed(
                  Option.some({
                    executionId: admittedExecutionId,
                    state: {
                      status: "Settled",
                      settlement: {
                        _tag: "Failed",
                        failure: {
                          _tag: "ExecutionFailure",
                          reason: "deterministic",
                        },
                      },
                    },
                  } as never),
                ),
            },
            clock: {
              now: () => Effect.succeed("2026-10-01T00:00:02.000Z"),
            },
            responseBodyOf: () => Effect.succeed(null),
          },
          projectId,
        ),
      );
      const after = yield* tx.transact(jobs.find(messageId));
      const secondTrigger = yield* runConversationResponseTrigger(
        triggerDeps,
        projectId,
      );
      return { admitted, sweep, after, secondTrigger };
    });

    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.admitted[0]).toMatch(/^admitted:exe_/);
    expect(result.sweep).toEqual([`needsattention:${messageId}`]);
    expect(Option.getOrThrow(result.after).state).toMatchObject({
      _tag: "NeedsAttention",
      reason: "UnknownFailure",
    });
    expect(result.secondTrigger).toEqual([]);
    expect(gatewayCalls).toBe(1);
  });
});
