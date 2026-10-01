import {
  ExecutionId,
  MessageId,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import {
  ConversationAttemptStore,
  ConversationResponseJobStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ConversationAttemptStoreLive,
  ConversationResponseJobStoreLive,
  layer,
  P21_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const messageId = parse(MessageId)("msg_018f2b3c-4d5e-7abc-8def-0123456789a1");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

describe("P17 conversation response stores", () => {
  it("CAS-transitions one eligible Job and records one append-only Attempt", async () => {
    const base = layer({ filename: ":memory:" });
    const txLayer = Layer.provide(TransactionPortLive, base);
    const stores = Layer.mergeAll(
      Layer.provide(ConversationResponseJobStoreLive, base),
      Layer.provide(ConversationAttemptStoreLive, base),
      txLayer,
      base,
    );
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
      const queued = {
        messageId,
        projectId,
        rootWorkspaceId: workspaceId,
        state: { _tag: "Queued" as const },
        nextAttemptNo: 0,
        policyVersion: "conversation-retry-v1",
        providerReasoning: null,
        lastFailureClass: null,
        revision: 0,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      };
      yield* tx.transact(jobs.insert(queued));
      const eligible = yield* tx.transact(
        jobs.listEligible("2026-10-01T00:00:01.000Z"),
      );
      const running = yield* tx.transact(
        jobs.transition({
          messageId,
          expectedRevision: 0,
          expectedState: "Queued",
          next: {
            ...queued,
            state: { _tag: "Running", attemptNo: 0, executionId },
            nextAttemptNo: 1,
            revision: 1,
            updatedAt: "2026-10-01T00:00:01.000Z",
          },
        }),
      );
      yield* tx.transact(
        attempts.insert({
          messageId,
          attemptNo: 0,
          executionId,
          admittedAt: "2026-10-01T00:00:01.000Z",
          settledAt: null,
          settlementKind: null,
          failureClass: null,
          failureFingerprint: null,
          retryDecision: null,
          policyVersion: "conversation-retry-v1",
        }),
      );
      const runningRows = yield* tx.transact(jobs.listRunning(projectId));
      const attemptRows = yield* tx.transact(attempts.list(messageId));
      return { eligible, running, runningRows, attemptRows };
    });

    const result = await Effect.runPromise(Effect.provide(program, stores));
    expect(result.eligible).toHaveLength(1);
    expect(result.running.state).toEqual({
      _tag: "Running",
      attemptNo: 0,
      executionId,
    });
    expect(result.runningRows).toHaveLength(1);
    expect(result.attemptRows).toEqual([
      expect.objectContaining({ messageId, attemptNo: 0, executionId }),
    ]);
  });
});
