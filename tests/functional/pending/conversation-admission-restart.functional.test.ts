import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect, test } from "vitest";
import {
  buildSingleWorkspaceLayer,
  type SingleWorkspaceServices,
} from "../../../apps/single-workspace/src/composition.js";
import { ProductionDaemonService } from "../../../apps/single-workspace/src/production.js";
import { externalContext } from "../../../apps/single-workspace/src/transport/auth.js";
import { makeExternalSubmissionFromServices } from "../../../apps/single-workspace/src/transport/composition.js";
import {
  CommandGateway,
  runConversationResponseTrigger,
} from "../../../packages/application/src/index.js";
import {
  MessageId,
  Principal,
  ProjectId,
  parse,
} from "../../../packages/domain/src/index.js";
import {
  Clock,
  ConversationAttemptStore,
  ConversationResponseJobStore,
  ExecutionRepository,
  ProjectRepository,
  TransactionPort,
} from "../../../packages/ports/src/index.js";
import { functionalId } from "../support/public-client.js";
import {
  cloneFunctionalCurrentSchemaDatabase,
  createFunctionalFixtureDirectory,
  removeFunctionalFixtureDirectory,
} from "../support/schema44-bootstrap.js";

test("an orphaned conversation admission is surfaced for resend after restart", async () => {
  const directory = createFunctionalFixtureDirectory();
  const { databaseFile } =
    await cloneFunctionalCurrentSchemaDatabase(directory);
  const human = parse(Principal)("user:local");
  const principal = parse(Principal)("runtime:system");
  const projectId = parse(ProjectId)(functionalId("prj"));
  const workspaceId = functionalId("ws");
  const sessionId = functionalId("ses");
  const messageId = parse(MessageId)(functionalId("msg"));
  const run = <Value>(
    program: Effect.Effect<Value, unknown, SingleWorkspaceServices>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          program,
          buildSingleWorkspaceLayer({
            databaseFile,
            governance: { authenticatedHumans: [human], directParentOf: [] },
          }),
        ),
      ),
    );
  const snapshot = Effect.gen(function* () {
    const sql = yield* SqlClient;
    return (yield* sql.unsafe<{
      state: string;
      revision: number;
      next_attempt_no: number;
      active_execution_id: string | null;
      executions: number;
      attempts: number;
      settled_executions: number;
    }>(
      `SELECT j.state, j.revision, j.next_attempt_no, j.active_execution_id,
      (SELECT COUNT(*) FROM executions) AS executions,
      (SELECT COUNT(*) FROM conversation_attempts) AS attempts,
      (SELECT COUNT(*) FROM executions WHERE settled_at IS NOT NULL) AS settled_executions
      FROM conversation_response_jobs j WHERE j.message_id = ?`,
      [messageId],
    ))[0];
  });
  const trigger = () =>
    Effect.gen(function* () {
      const gateway = yield* CommandGateway;
      const jobs = yield* ConversationResponseJobStore;
      const attempts = yield* ConversationAttemptStore;
      const projects = yield* ProjectRepository;
      const executions = yield* ExecutionRepository;
      const clock = yield* Clock;
      const tx = yield* TransactionPort;
      return yield* runConversationResponseTrigger(
        {
          gateway,
          jobs,
          projects,
          executions,
          clock,
          tx,
          principal,
          attempts,
        },
        projectId,
      );
    });
  try {
    await run(
      Effect.gen(function* () {
        const submission = yield* makeExternalSubmissionFromServices({
          authenticatedHumans: [human],
          directParentOf: [],
        });
        const submit = (commandType: string, payload: unknown) =>
          submission.submit(human, externalContext(human), {
            commandType,
            projectId,
            commandId: functionalId("cmd"),
            actor: "user:local",
            issuedAt: new Date().toISOString(),
            payload,
          });
        const created = yield* submit("CreateProject", {
          name: "conversation admission recovery",
          revision: 0,
          projectPolicy: {},
          projectPolicyRevision: 0,
          defaultConfiguration: {},
          environmentRef: "local",
          rootWorkspaceId: workspaceId,
          primarySession: { sessionId, contextEpoch: 0 },
          rootWorkspace: {
            name: "root",
            responsibilityDefinition: {
              purpose: "conversation admission recovery",
              ownedResponsibilities: [],
              obligations: [],
              includes: [],
              excludes: [],
              interfaces: [],
            },
            responsibilityRevision: 0,
            resourceSelection: { _tag: "ConversationOnly" },
            agentBinding: {
              _tag: "ResponsibilityBoundAgentBinding",
              workspaceId,
            },
            workspacePolicy: {},
            workspacePolicyRevision: 0,
            revision: 0,
          },
        });
        expect(created).toMatchObject({
          ok: true,
          body: { resolution: "Committed" },
        });
        const submitted = yield* submit("SubmitHumanMessage", {
          messageId,
          targetWorkspaceId: workspaceId,
          bodyRef: "retain this message after restart",
        });
        expect(submitted).toMatchObject({
          ok: true,
          body: { resolution: "Committed" },
        });

        expect(yield* trigger()).toEqual([expect.stringMatching(/^admitted:/)]);
        const tx = yield* TransactionPort;
        expect(yield* tx.transact(snapshot)).toMatchObject({
          state: "Running",
          next_attempt_no: 1,
          executions: 1,
          attempts: 1,
        });

        const sql = yield* SqlClient;
        // Recreate the durable state left by the previously observed crash:
        // the Execution survived, but the response binding transaction did
        // not. The production recovery path must expose resend instead of
        // re-admitting attempt 0.
        yield* sql.unsafe(
          `UPDATE conversation_response_jobs
             SET state = 'Queued', active_execution_id = NULL,
                 next_attempt_no = 0, attention_reason = NULL,
                 last_failure_class = NULL, last_failure_fingerprint = NULL,
                 revision = 0
           WHERE message_id = ?`,
          [messageId],
        );
        yield* sql.unsafe(
          "DELETE FROM conversation_attempts WHERE message_id = ?",
          [messageId],
        );

        const daemon = yield* ProductionDaemonService;
        yield* daemon.recovery.startup;
        expect(yield* tx.transact(snapshot)).toMatchObject({
          state: "NeedsAttention",
          next_attempt_no: 1,
          active_execution_id: expect.any(String),
          executions: 1,
          attempts: 1,
          settled_executions: 1,
        });
      }),
    );

    const resent = await run(
      Effect.gen(function* () {
        const submission = yield* makeExternalSubmissionFromServices({
          authenticatedHumans: [human],
          directParentOf: [],
        });
        const resumed = yield* submission.submit(
          human,
          externalContext(human),
          {
            commandType: "ResumeConversationResponse",
            projectId,
            commandId: functionalId("cmd"),
            actor: "user:local",
            issuedAt: new Date().toISOString(),
            payload: { messageId, expectedJobRevision: 1 },
          },
        );
        expect(resumed, JSON.stringify(resumed)).toMatchObject({
          ok: true,
          body: { resolution: "Committed" },
        });
        expect(yield* trigger()).toEqual([expect.stringMatching(/^admitted:/)]);
        const tx = yield* TransactionPort;
        const jobs = yield* ConversationResponseJobStore;
        const sql = yield* SqlClient;
        const current = yield* tx.transact(jobs.find(messageId));
        const snapshotValue = yield* tx.transact(snapshot);
        // Exercise the second legacy boundary too: Attempt exists, but the
        // Job transition was interrupted while the Execution stayed Active.
        // Recovery must settle that Attempt and Execution before a later
        // resend can claim the workspace.
        yield* sql.unsafe(
          `UPDATE conversation_response_jobs
             SET state = 'Queued', active_execution_id = NULL,
                 next_attempt_no = 1, attention_reason = NULL,
                 last_failure_class = NULL, last_failure_fingerprint = NULL,
                 revision = 2
           WHERE message_id = ?`,
          [messageId],
        );
        const daemon = yield* ProductionDaemonService;
        yield* daemon.recovery.sweep;
        const recoveredCurrent = yield* tx.transact(jobs.find(messageId));
        const recoveredSnapshot = yield* tx.transact(snapshot);
        return {
          current,
          snapshot: snapshotValue,
          recoveredCurrent,
          recoveredSnapshot,
        };
      }),
    );
    expect(Option.getOrThrow(resent.current).state).toMatchObject({
      _tag: "Running",
      attemptNo: 1,
    });
    expect(resent.snapshot).toMatchObject({
      state: "Running",
      next_attempt_no: 2,
      executions: 2,
      attempts: 2,
      settled_executions: 1,
    });
    expect(Option.getOrThrow(resent.recoveredCurrent).state).toMatchObject({
      _tag: "NeedsAttention",
    });
    expect(resent.recoveredSnapshot).toMatchObject({
      state: "NeedsAttention",
      next_attempt_no: 2,
      attempts: 2,
      settled_executions: 2,
    });
  } finally {
    removeFunctionalFixtureDirectory(directory);
  }
});
