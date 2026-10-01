import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ConversationResponseJobStoreLive,
  layer,
  P21_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
  makeCancelConversationResponseHandler,
  makeResumeConversationResponseHandler,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  MessageId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  ConversationResponseJobStore,
  TransactionPort,
} from "../packages/ports/src/index.js";

const messageId = parse(MessageId)("msg_018f2b3c-4d5e-7abc-8def-0123456789a1");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const principal = parse(Principal)("user:test");

describe("P17 conversation response commands", () => {
  it("resolves authenticated human authority bound to project and message", async () => {
    const fact = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const resolver = yield* AuthorityResolverPort;
          return yield* resolver.resolve({
            principal,
            submissionContext: { _tag: "External", principal },
            envelope: {
              commandType: "ResumeConversationResponse",
              commandId: parse(CommandId)(
                "cmd_018f2b3c-4d5e-7abc-8def-0123456789a9",
              ),
              projectId,
              actor: parse(Actor)("user:test"),
              issuedAt: "2026-10-01T00:00:00.000Z",
              payload: { messageId, expectedJobRevision: 2 },
            },
            semanticRequestFingerprint: "fp:test",
            canonicalFacts: {
              projectId,
              project: { rootWorkspaceId: workspaceId },
              workspace: {
                workspaceId,
                projectId,
                parentWorkspaceId: null,
              },
            },
            grants: [],
            governance: { authenticatedHumans: [], directParentOf: [] },
            policy: {},
          } as never);
        }),
        AuthorityResolverPortLive,
      ) as unknown as Effect.Effect<{ _tag: string; messageId: string }>,
    );
    expect(fact).toMatchObject({
      _tag: "ConversationResponseAuthority",
      messageId,
    });
  });

  it("resumes Attention with revision CAS, then allows cancellation while queued", async () => {
    const base = layer({ filename: ":memory:" });
    const txLayer = Layer.provide(TransactionPortLive, base);
    const app = Layer.mergeAll(
      Layer.provide(ConversationResponseJobStoreLive, base),
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
          principal,
          "body",
          "cmd:seed",
          "fp:seed",
          "2026-10-01T00:00:00.000Z",
        ],
      );
      const jobs = yield* ConversationResponseJobStore;
      const tx = yield* TransactionPort;
      yield* tx.transact(
        jobs.insert({
          messageId,
          projectId,
          rootWorkspaceId: workspaceId,
          state: {
            _tag: "NeedsAttention",
            reason: "DeterministicModelFailure",
            failureFingerprint: "cff_test",
          },
          nextAttemptNo: 1,
          policyVersion: "conversation-retry-v1",
          providerReasoning: null,
          lastFailureClass: "DeterministicModelFailure",
          revision: 2,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:02.000Z",
        }),
      );
      const resume = makeResumeConversationResponseHandler({ jobs });
      const resumed = yield* tx.transact(
        resume.execute(
          {
            commandType: "ResumeConversationResponse",
            commandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
            ),
            projectId,
            actor: parse(Actor)("user:test"),
            issuedAt: "2026-10-01T00:00:03.000Z",
            payload: { messageId, expectedJobRevision: 2 },
          },
          { _tag: "External", principal },
        ),
      );
      const cancel = makeCancelConversationResponseHandler({ jobs });
      const cancelled = yield* tx.transact(
        cancel.execute(
          {
            commandType: "CancelConversationResponse",
            commandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
            ),
            projectId,
            actor: parse(Actor)("user:test"),
            issuedAt: "2026-10-01T00:00:04.000Z",
            payload: { messageId, expectedJobRevision: 3 },
          },
          { _tag: "External", principal },
        ),
      );
      const found = yield* tx.transact(jobs.find(messageId));
      return { resumed, cancelled, found };
    });

    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.resumed).toMatchObject({
      ok: true,
      value: { result: { state: "Queued", revision: 3 } },
    });
    expect(result.cancelled).toMatchObject({
      ok: true,
      value: { result: { state: "Cancelled", revision: 4 } },
    });
    expect(Option.getOrThrow(result.found).state).toEqual({
      _tag: "Cancelled",
      reason: "HumanCancelled",
    });
  });
});
