import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentLoopStepStoreLive,
  ClockLive,
  layer,
  P36_MIGRATIONS,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { executeAgentLoopActions } from "../packages/agent-runtime/src/agent-loop-actions.js";
import {
  type AgentLoopStepRecord,
  AgentLoopStepStore,
  SessionRepository,
  TransactionPort,
} from "../packages/ports/src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1";
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";
const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a1";
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1";
const callRef = "call-p40-p3-production";
const invocationId = "tin_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workerId = "worker:p40-p3";
const incarnationId = "incarnation:p40-p3";
const now = "2026-10-12T00:00:01.000Z";
const resultRef = "art_018f2b3c-4d5e-7abc-8def-0123456789a2";
const factId = "f".repeat(64);
const observation = { text: "bounded stored result", truncated: false };
const fence = {
  executionId,
  workerId,
  workerIncarnationId: incarnationId,
  fencingGeneration: 0,
} as never;
const directories: string[] = [];

const makeFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "p40-p3-production-"));
  directories.push(directory);
  const sqlite = layer({ filename: join(directory, "p3.db") });
  const infra = Layer.mergeAll(sqlite, ClockLive);
  const stores = Layer.mergeAll(
    TransactionPortLive,
    AgentLoopStepStoreLive,
    SessionRepositoryLive,
  );
  const app = Layer.provideMerge(stores, infra);
  return { app };
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* runMigrations(P36_MIGRATIONS);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'P40 P3', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
        [projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [sessionId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
        [workspaceId, projectId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
          'P40 P3 production transaction', ?, 't0', NULL, NULL, NULL, NULL)`,
        [executionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO execution_leases (
          execution_id, worker_id, worker_incarnation_id, generation,
          expires_at, updated_at
        ) VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', 't0')`,
        [executionId, workerId, incarnationId],
      );
    }),
  );
});

const preparedStep: AgentLoopStepRecord = {
  identity: {
    executionId: executionId as never,
    logicalStepNo: 0,
    repairAttempt: 0,
  },
  providerTurnId: providerTurnId as never,
  state: "Prepared",
  nextActionIndex: 0,
  revision: 0,
  updatedAt: now,
};

const actionInput = (
  loopStep: AgentLoopStepRecord,
  executableInvocationHandler: {
    handle: () => Effect.Effect<unknown, unknown>;
  },
  qualificationProbe?: (event: { readonly boundary: string }) => Promise<void>,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const sessions = yield* SessionRepository;
    const loopSteps = yield* AgentLoopStepStore;
    return yield* executeAgentLoopActions({
      input: {
        execution: {
          executionId,
          workspaceId,
          projectId,
          sessionId,
          binding: { _tag: "WorkspaceAgentBinding" },
        } as never,
        context: {
          _tag: "ExecutionOrigin",
          principal: "worker:p40-p3",
        } as never,
      },
      preparedTurn: {
        manifest: {
          providerTurnId,
          contextEpoch: 0,
          controlBasis: {
            workspacePolicyRevision: 0,
            projectPolicyRevision: 0,
          },
        },
        toolRoutes: [{ name: "read", route: "Executable" }],
      } as never,
      decodedOutput: {
        text: "",
        finishReason: "ToolCalls",
        toolInvocations: [
          {
            providerTurnId,
            outputPosition: 0,
            callRef,
            toolName: "read",
            argumentsJson: "{}",
          },
        ],
      } as never,
      turn: 0,
      currentLoopStep: loopStep,
      loopSteps,
      loopStepFence: fence,
      tx,
      sessions,
      controlRegistry: {
        classify: () => "NotControl",
        definitions: () => [],
        decode: () => Effect.die("executable route must not decode as control"),
        handle: () =>
          Effect.die("executable route must not use control handler"),
      } as never,
      executableInvocationHandler: executableInvocationHandler as never,
      currentControlBasis: () =>
        Effect.succeed({
          workspacePolicyRevision: 0,
          projectPolicyRevision: 0,
        } as never),
      admit: () => Effect.succeed("Continue"),
      failure: (cause: unknown) => cause as never,
      now: () => Effect.succeed(now),
      ...(qualificationProbe === undefined
        ? {}
        : { qualificationProbe: qualificationProbe as never }),
    } as never);
  });

describe("P40 production P3 SQLite observation handoff", () => {
  it.each([
    "AH7BeforeActionResultCommit",
    "AH7AfterActionResultCommit",
  ] as const)(
    "commits one sourced ToolResult, Applied Action and cursor after %s recovery",
    async (boundary) => {
      const { app } = makeFixture();
      let step!: AgentLoopStepRecord;
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* seed;
            const tx = yield* TransactionPort;
            const steps = yield* AgentLoopStepStore;
            const sql = yield* SqlClient;
            const stepTable = yield* sql.unsafe<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_loop_steps'",
            );
            if (stepTable.length !== 1) {
              throw new Error(
                `agent_loop_steps missing in seed connection; user_version=${JSON.stringify(yield* sql.unsafe("PRAGMA user_version"))}`,
              );
            }
            yield* tx.transact(steps.createPrepared(preparedStep, fence));
            step = yield* tx.transact(
              steps.transition(
                {
                  identity: preparedStep.identity,
                  expectedRevision: 0,
                  expectedState: "Prepared",
                  next: {
                    ...preparedStep,
                    state: "ActionsInProgress",
                    revision: 1,
                  },
                },
                fence,
              ),
            );
          }),
          app,
        ),
      );

      let runtimeCalls = 0;
      let executorCalls = 0;
      const handler = {
        handle: () =>
          Effect.sync(() => {
            runtimeCalls += 1;
            if (runtimeCalls === 1) executorCalls += 1;
            return {
              _tag: "Observation",
              source: "Tool",
              observation,
              status: "Failed",
              disposition: "ReconciledNoEffect:ReplayLimitReached",
              resultRef,
              artifactRefs: [resultRef],
              invocationId,
              reconciliationFactRef: factId,
            };
          }),
      };
      let crashOnce = true;
      const interrupted = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const outcome = yield* Effect.exit(
              actionInput(step, handler, async (event) => {
                if (event.boundary === boundary && crashOnce) {
                  crashOnce = false;
                  throw new Error("P3 commit boundary crash");
                }
              }),
            );
            return outcome;
          }),
          app,
        ),
      );
      expect(Exit.isFailure(interrupted)).toBe(true);

      const snapshotAfterCrash = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const steps = yield* AgentLoopStepStore;
            const sql = yield* SqlClient;
            const current = yield* tx.transact(
              steps.find(preparedStep.identity),
            );
            const rows = yield* sql.unsafe<{
              readonly count: number;
              readonly toolResults: number;
            }>(
              `SELECT COUNT(*) AS count,
                      COALESCE(SUM(CASE WHEN item_type = 'ToolResult' THEN 1 ELSE 0 END), 0) AS toolResults
                 FROM session_entries WHERE session_id = ?`,
              [sessionId],
            );
            const actions = yield* sql.unsafe<{
              readonly count: number;
              readonly state: string | null;
            }>(
              `SELECT COUNT(*) AS count, MIN(state) AS state FROM agent_loop_step_actions
                WHERE execution_id = ? AND logical_step_no = 0`,
              [executionId],
            );
            return { current, rows: rows[0], actions: actions[0] };
          }),
          app,
        ),
      );
      if (boundary === "AH7BeforeActionResultCommit") {
        expect(snapshotAfterCrash.rows).toEqual({ count: 0, toolResults: 0 });
        expect(snapshotAfterCrash.actions).toEqual({
          count: 1,
          state: "Pending",
        });
        expect(
          snapshotAfterCrash.current._tag === "Some" &&
            snapshotAfterCrash.current.value.nextActionIndex,
        ).toBe(0);
      } else {
        expect(snapshotAfterCrash.rows).toEqual({ count: 1, toolResults: 1 });
        expect(snapshotAfterCrash.actions).toEqual({
          count: 1,
          state: "Applied",
        });
        expect(
          snapshotAfterCrash.current._tag === "Some" &&
            snapshotAfterCrash.current.value.nextActionIndex,
        ).toBe(1);
      }

      const resumed = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const steps = yield* AgentLoopStepStore;
            const current = yield* tx.transact(
              steps.find(preparedStep.identity),
            );
            if (current._tag !== "Some") throw new Error("P3 step disappeared");
            return yield* actionInput(current.value, handler);
          }),
          app,
        ),
      );
      expect(resumed._tag).toBe("Completed");
      expect(runtimeCalls).toBe(
        boundary === "AH7BeforeActionResultCommit" ? 2 : 1,
      );
      expect(executorCalls).toBe(1);

      const finalState = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const steps = yield* AgentLoopStepStore;
            const sessions = yield* SessionRepository;
            const sql = yield* SqlClient;
            const current = yield* tx.transact(
              steps.find(preparedStep.identity),
            );
            const items = yield* tx.transact(
              sessions.listActiveFrontier(sessionId as never, 0 as never, 10),
            );
            const actions = yield* sql.unsafe<{
              readonly state: string;
              readonly result_ref: string | null;
              readonly observation_source_ref: string | null;
            }>(
              `SELECT state, result_ref, observation_source_ref
                 FROM agent_loop_step_actions
                WHERE execution_id = ? AND logical_step_no = 0 AND action_index = 0`,
              [executionId],
            );
            const rows = yield* sql.unsafe<{
              readonly item_type: string;
              readonly payload_json: string;
              readonly source_ref: string | null;
            }>(
              `SELECT item_type, payload_json, source_ref FROM session_entries
                WHERE session_id = ? AND item_type = 'ToolResult'`,
              [sessionId],
            );
            return { current, items, action: actions[0], row: rows[0] };
          }),
          app,
        ),
      );
      expect(
        finalState.current._tag === "Some" &&
          finalState.current.value.nextActionIndex,
      ).toBe(1);
      expect(finalState.action?.state).toBe("Applied");
      expect(finalState.row?.item_type).toBe("ToolResult");
      expect(finalState.row?.source_ref).toBe(
        finalState.action?.observation_source_ref,
      );
      expect(finalState.items).toHaveLength(1);
      const item = JSON.parse(finalState.row?.payload_json ?? "null") as Record<
        string,
        unknown
      >;
      expect(item).toMatchObject({
        _tag: "ToolResult",
        callRef,
        invocationId,
        status: "Failed",
        disposition: "ReconciledNoEffect:ReplayLimitReached",
        reconciliationFactRef: factId,
        modelOutputRef: resultRef,
        outputText: observation.text,
      });
      expect(resultRef).not.toBe(factId);
    },
  );
});
