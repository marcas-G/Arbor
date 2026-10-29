import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobStorePortLive } from "../adapters/blob-local/src/index.js";
import {
  AgentLoopStepStoreLive,
  ArtifactMetadataRepositoryLive,
  ClockLive,
  SessionRepositoryLive,
  layer as sqliteLayer,
  ToolInvocationStoreLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { executeAgentLoopActions } from "../packages/agent-runtime/src/agent-loop-actions.js";
import {
  Actor,
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  AgentLoopStepStore,
  makeToolReconciliationProfileRegistry,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  SessionRepository,
  type ToolExecutionContext,
  type ToolInvocationIntent,
  ToolInvocationStore,
  ToolReconciliationFactStore,
  ToolReconciliationPort,
  ToolReconciliationProfileRegistry,
  ToolRuntimePort,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { ArtifactServiceLive } from "../packages/tool-runtime/src/artifact.js";
import {
  BUILTIN_EXECUTORS,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
} from "../packages/tool-runtime/src/index.js";
import type { ToolExecutor } from "../packages/tool-runtime/src/runtime.js";
import { createSchema44TestDatabaseFactory } from "./support/schema44-database.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const principal = parse(Principal)("worker:ah7-shell2-legacy");
const actor = parse(Actor)("worker:ah7-shell2-legacy");
const workerId = String(principal);
const incarnationId = "incarnation:ah7-shell2-legacy";
const callRef = "call_ah7_shell2_legacy_recovery";
const argumentsJson = JSON.stringify({
  command: "pwd",
  cwd: { mount: "workspace", path: "." },
});
const invocationFence = {
  executionId,
  workerId,
  workerIncarnationId: incarnationId,
  fencingGeneration: parse(LeaseGeneration)(0),
};
const controlBasisDigest = "schema44-ah7-shell2-legacy";

let schema44Factory: Awaited<
  ReturnType<typeof createSchema44TestDatabaseFactory>
>;

beforeAll(async () => {
  schema44Factory = await createSchema44TestDatabaseFactory({
    prefix: "ah7-shell2-profileless-schema44-",
  });
}, 120_000);

afterAll(() => schema44Factory?.cleanup());

const sourceRevision = JSON.stringify({
  workspacePolicyRevision: 0,
  activeGrants: [],
  verifierId: null,
});

const seedWorkspaceAndExecution = (
  filename: string,
  workspaceRoot: string,
): void => {
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO projects (
        project_id, name, root_workspace_id, project_policy,
        project_policy_revision, default_configuration, environment_ref,
        lifecycle, revision, created_at, updated_at
      ) VALUES (?, 'AH7 legacy shell', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
    ).run(projectId, workspaceId);
    db.prepare(
      `INSERT INTO workspaces (
        workspace_id, project_id, parent_workspace_id, name,
        responsibility_definition, responsibility_revision, resource_boundary,
        resource_boundary_revision, agent_binding, primary_session_id,
        current_work_id, workspace_policy, workspace_policy_revision,
        revision, lifecycle, created_at, updated_at
      ) VALUES (?, ?, NULL, 'legacy-shell-workspace', '{}', 0, ?, 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
    ).run(
      workspaceId,
      projectId,
      JSON.stringify({
        basisResponsibilityRevision: 0,
        addresses: [{ _tag: "GitWorktree", path: workspaceRoot }],
      }),
      sessionId,
    );
    db.prepare(
      `INSERT INTO sessions (
        session_id, binding_kind, workspace_id, execution_id,
        context_epoch, created_at
      ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
    ).run(sessionId, workspaceId);
    db.prepare(
      `INSERT INTO executions (
        execution_id, project_id, binding_kind, workspace_id,
        episode_kind, episode_ref, episode_revision, parent_execution_id,
        mission, session_id, admitted_at, stop_requested_at,
        settlement_kind, settlement_json, settled_at
      ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
        'schema44 legacy shell recovery', ?, 't0', NULL, NULL, NULL, NULL)`,
    ).run(executionId, projectId, workspaceId, sessionId);
    db.prepare(
      `INSERT INTO execution_leases (
        execution_id, worker_id, worker_incarnation_id, generation,
        expires_at, updated_at
      ) VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', 't0')`,
    ).run(executionId, workerId, incarnationId);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  } finally {
    db.close();
  }
};

const makeApp = (
  databaseFilename: string,
  workspaceRoot: string,
  counters: {
    executor: number;
    reconcile: number;
    fact: number;
    probe: string[];
  },
) => {
  const base = sqliteLayer({ filename: databaseFilename });
  const infra = Layer.mergeAll(base, ClockLive);
  const sandbox = Layer.succeed(SandboxPort, {
    open: () =>
      Effect.succeed({
        handleId: "schema44-ah7-shell2",
        rootPath: workspaceRoot,
        writableRegions: [],
      }),
    close: () => Effect.void,
  });
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(AgentLoopStepStoreLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(ArtifactMetadataRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    ToolDefinitionStoreLive,
    BlobStorePortLive,
    sandbox,
    Layer.succeed(ResourceAdmission, {
      admit: () => Effect.succeed({ _tag: "Admitted" as const }),
    } as never),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_project, addresses) =>
        Effect.succeed({
          regions: addresses.map((address) => ({
            resourceSpaceId: "filesystem",
            normalizedRegion: address,
          })),
          observedEnvironmentRevision: "schema44-ah7-legacy",
        }),
    }),
    Layer.succeed(
      ToolReconciliationProfileRegistry,
      makeToolReconciliationProfileRegistry([]),
    ),
    Layer.succeed(ToolReconciliationPort, {
      reconcile: () =>
        Effect.sync(() => {
          counters.reconcile += 1;
          return { _tag: "StillUnknown" as const };
        }),
    } as never),
    Layer.succeed(ToolReconciliationFactStore, {
      record: () =>
        Effect.sync(() => {
          counters.fact += 1;
          return {};
        }),
    } as never),
  );
  const all = Layer.mergeAll(deps, infra);
  const artifacts = Layer.provide(ArtifactServiceLive, all);
  const runtimeDeps = Layer.mergeAll(all, artifacts);
  const executors: ReadonlyArray<ToolExecutor> = BUILTIN_EXECUTORS.map(
    (executor) =>
      executor.name !== "shell"
        ? executor
        : {
            ...executor,
            execute: () =>
              Effect.sync(() => {
                counters.executor += 1;
                return {
                  settlement: { _tag: "Success" as const },
                  observation: {
                    text: "unexpected execution",
                    truncated: false,
                  },
                  resultRef: null,
                };
              }),
          },
  );
  const toolRuntime = Layer.provide(
    ToolRuntimeLive(executors, {
      qualificationProbe: async ({ boundary }) => {
        counters.probe.push(boundary);
      },
    }),
    runtimeDeps,
  );
  return Layer.mergeAll(infra, deps, artifacts, toolRuntime);
};

const invocationAuthority = {
  principal,
  workspaceId,
  executionId,
  toolName: "shell",
  toolVersion: "2",
  sourceRevision,
  resourceSpaceIds: ["filesystem"],
  allowedCapabilities: ["shell:exec"],
  controlBasisDigest,
  expiresAt: "2999-01-01T00:00:00.000Z",
  delegationDepth: 0,
};

const p4Context = (requestedAt: string): ToolExecutionContext => ({
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority: invocationAuthority,
  controlBasisDigest,
  executionFence: invocationFence,
  requestedAt,
});

describe("schema44 SQLite AH7 legacy shell@2 recovery", () => {
  it("replays profile-less MayHaveStarted as OutcomeUnknown and persists P3 ReconciliationPending", async () => {
    const fixture = schema44Factory.create();
    const workspacePath = join(fixture.directory, "workspace");
    mkdirSync(workspacePath);
    const workspaceRoot = realpathSync.native(workspacePath);
    seedWorkspaceAndExecution(fixture.databaseFilename, workspaceRoot);
    const counters = {
      executor: 0,
      reconcile: 0,
      fact: 0,
      probe: [] as string[],
    };
    const app = makeApp(fixture.databaseFilename, workspaceRoot, counters);
    const timestamp = new Date().toISOString();
    const regions = [
      {
        resourceSpaceId: "filesystem",
        normalizedRegion: {
          _tag: "GitWorktree" as const,
          path: workspaceRoot,
        },
      },
    ];
    const legacyIntent: ToolInvocationIntent = {
      invocationId,
      executionId,
      workspaceId,
      toolName: "shell",
      toolVersion: "2",
      sideEffectSemantics: "Reconcilable",
      argumentsJson,
      resolvedRegions: regions,
      approvalId: null,
      intentAt: timestamp,
    };

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const invocations = yield* ToolInvocationStore;
          const seeded = yield* tx.transact(
            Effect.gen(function* () {
              const recorded = yield* invocations.recordIntent(
                legacyIntent,
                invocationFence,
                timestamp,
              );
              if (recorded !== "Recorded") {
                throw new Error(`legacy intent record returned ${recorded}`);
              }
              return yield* invocations.admitEffect(
                invocationId,
                invocationAuthority,
                timestamp,
                invocationFence,
              );
            }),
          );
          expect(seeded).toEqual({ _tag: "Admitted" });
        }),
        app,
      ),
    );

    const before = new DatabaseSync(fixture.databaseFilename, {
      readOnly: true,
    });
    try {
      expect(
        Number(
          (
            before.prepare("PRAGMA user_version").get() as {
              readonly user_version: number;
            }
          ).user_version,
        ),
      ).toBe(44);
      expect(
        before
          .prepare(
            `SELECT tool_name, tool_version, side_effect_semantics,
                    effect_admission_state, recovery_binding_state,
                    recovery_binding_sha256, settled_at, settlement_kind,
                    result_ref
               FROM tool_invocations WHERE invocation_id = ?`,
          )
          .get(invocationId),
      ).toEqual({
        tool_name: "shell",
        tool_version: "2",
        side_effect_semantics: "Reconcilable",
        effect_admission_state: "MayHaveStarted",
        recovery_binding_state: "LegacyBindingUnproven",
        recovery_binding_sha256: null,
        settled_at: null,
        settlement_kind: null,
        result_ref: null,
      });
    } finally {
      before.close();
    }

    const first = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            {
              callRef,
              toolName: "shell",
              toolVersion: "2",
              argumentsJson,
              invocationId,
              approvalId: null,
            },
            p4Context(timestamp),
          );
        }),
        app,
      ),
    );
    expect(first).toEqual({
      _tag: "OutcomeUnknown",
      reconciliationRefs: [String(invocationId)],
    });

    const second = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const steps = yield* AgentLoopStepStore;
          const sessions = yield* SessionRepository;
          const runtime = yield* ToolRuntimePort;
          const currentStep = {
            identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
            providerTurnId,
            state: "Prepared" as const,
            nextActionIndex: 0,
            revision: 0,
            updatedAt: timestamp,
          };
          yield* tx.transact(
            steps.createPrepared(currentStep, invocationFence),
          );
          const actionsInProgress = yield* tx.transact(
            steps.transition(
              {
                identity: currentStep.identity,
                expectedRevision: 0,
                expectedState: "Prepared",
                next: {
                  ...currentStep,
                  state: "ActionsInProgress",
                  revision: 1,
                  updatedAt: timestamp,
                },
              },
              invocationFence,
            ),
          );
          let secondRecovery: unknown;
          const actionResult = yield* executeAgentLoopActions({
            input: {
              execution: {
                executionId,
                workspaceId,
                projectId,
                sessionId,
                binding: { _tag: "WorkspaceAgentBinding" },
              } as never,
              context: { _tag: "ExecutionOrigin", principal } as never,
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
              toolRoutes: [{ name: "shell", route: "Executable" }],
            } as never,
            decodedOutput: {
              text: "",
              finishReason: "ToolCalls",
              toolInvocations: [
                {
                  providerTurnId,
                  outputPosition: 0,
                  callRef,
                  toolName: "shell",
                  argumentsJson,
                },
              ],
            } as never,
            turn: 0,
            currentLoopStep: actionsInProgress,
            loopSteps: steps,
            loopStepFence: invocationFence,
            tx,
            sessions,
            controlRegistry: {
              classify: () => "NotControl",
              definitions: () => [],
              decode: () => Effect.die("shell is executable"),
              handle: () => Effect.die("shell is executable"),
            } as never,
            executableInvocationHandler: {
              handle: () =>
                Effect.gen(function* () {
                  secondRecovery = yield* runtime.invoke(
                    {
                      callRef,
                      toolName: "shell",
                      toolVersion: "2",
                      argumentsJson,
                      invocationId,
                      approvalId: null,
                    },
                    p4Context(timestamp),
                  );
                  if (
                    typeof secondRecovery === "object" &&
                    secondRecovery !== null &&
                    "_tag" in secondRecovery &&
                    secondRecovery._tag === "OutcomeUnknown"
                  ) {
                    return {
                      _tag: "Settle" as const,
                      settlement: {
                        _tag: "OutcomeUnknown" as const,
                        reconciliation: {
                          _tag: "ReconciliationRequired" as const,
                          invocationRefs: [String(invocationId)],
                        },
                      },
                    };
                  }
                  return yield* Effect.die("legacy recovery was not unknown");
                }),
            } as never,
            currentControlBasis: () =>
              Effect.succeed({
                workspacePolicyRevision: 0,
                projectPolicyRevision: 0,
              } as never),
            admit: () => Effect.succeed("Continue"),
            failure: (cause: unknown) => cause as never,
            now: () => Effect.succeed(timestamp),
          } as never);
          return { actionResult, secondRecovery };
        }),
        app,
      ),
    );
    expect(second.actionResult).toMatchObject({
      _tag: "Settle",
      settlement: { _tag: "OutcomeUnknown" },
    });
    expect(second.secondRecovery).toEqual(first);

    const final = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const invocations = yield* ToolInvocationStore;
          const steps = yield* AgentLoopStepStore;
          const p4 = yield* tx.transact(invocations.findById(invocationId));
          const step = yield* tx.transact(
            steps.find({ executionId, logicalStepNo: 0, repairAttempt: 0 }),
          );
          const actions = yield* tx.transact(
            steps.listActions({
              executionId,
              logicalStepNo: 0,
              repairAttempt: 0,
            }),
          );
          return { p4, step, actions };
        }),
        app,
      ),
    );
    expect(final.p4).toEqual(
      Option.some(
        expect.objectContaining({
          effectAdmissionState: "MayHaveStarted",
          settledAt: null,
          settlement: null,
          resultRef: null,
        }),
      ),
    );
    expect(final.step).toMatchObject({
      _tag: "Some",
      value: {
        state: "SettlementProposed",
        settlement: { _tag: "OutcomeUnknown" },
      },
    });
    expect(final.actions).toHaveLength(1);
    expect(final.actions[0]).toMatchObject({
      callRef,
      actionKind: "shell",
      state: "ReconciliationPending",
    });

    const after = new DatabaseSync(fixture.databaseFilename, {
      readOnly: true,
    });
    try {
      const counts = after
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM tool_invocation_recovery_bindings WHERE invocation_id = ?) AS bindings,
             (SELECT COUNT(*) FROM tool_invocation_effect_attempts WHERE invocation_id = ?) AS attempts,
             (SELECT COUNT(*) FROM tool_reconciliation_facts WHERE invocation_id = ?) AS facts`,
        )
        .get(invocationId, invocationId, invocationId) as {
        readonly bindings: number;
        readonly attempts: number;
        readonly facts: number;
      };
      expect(counts).toMatchObject({
        bindings: 0,
        attempts: 0,
        facts: 0,
      });
      expect(
        after
          .prepare(
            `SELECT effect_admission_state, settled_at, settlement_kind,
                    settlement_json, result_ref
               FROM tool_invocations WHERE invocation_id = ?`,
          )
          .get(invocationId),
      ).toMatchObject({
        effect_admission_state: "MayHaveStarted",
        settled_at: null,
        settlement_kind: null,
        settlement_json: null,
        result_ref: null,
      });
    } finally {
      after.close();
      fixture.cleanup();
    }

    expect(counters.executor).toBe(0);
    expect(counters.reconcile).toBe(0);
    expect(counters.fact).toBe(0);
    expect(counters.probe).not.toContain("AH7BeforeEffectAdmission");
    expect(counters.probe).not.toContain("AH7AfterEffectAdmissionCommit");
  }, 120_000);
});
