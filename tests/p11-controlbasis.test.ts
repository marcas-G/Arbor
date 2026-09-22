import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  P8_MIGRATIONS,
  ProviderTurnStoreLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { FakeProviderLive } from "../adapters/provider-fake/src/index.js";
import {
  AgentDriverLive,
  checkFreshness,
} from "../packages/agent-runtime/src/index.js";
import {
  type AgentExecutionState,
  type CommandSubmissionContext,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  AGENT_DIRECTIVE_CONTRACT,
  type ControlBasis,
  ModelContext,
  type PrepareTurnInput,
} from "../packages/model-context/src/index.js";
import {
  EnvironmentRevisionStore,
  ExecutionDriverPort,
  ModelCapabilityPort,
  type RuntimeSafetyGateService,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../packages/provider-runtime/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789b1");
// Same project (anchor is project-scoped), one workspace per execution:
// the schema allows only one unsettled workspace-binding execution per workspace.
const workspaceIds = [
  parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;
const sessionIds = [
  parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;
const executionIds = [
  parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;
const principal = parse(Principal)("worker:a");

const executionOf = (index: 0 | 1): Execution => ({
  executionId: executionIds[index],
  projectId,
  workspaceId: workspaceIds[index],
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId: workspaceIds[index],
    focus: { _tag: "Coordination" },
  },
  sessionId: sessionIds[index],
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
});

const stateOf = (index: 0 | 1): AgentExecutionState => ({
  executionId: executionIds[index],
  focus: { _tag: "Coordination" },
  wakeReason: { _tag: "WorkSelected" },
  currentMode: "execute",
  activeSkillRefs: [],
  turnNo: 0,
  recentDirectiveRefs: [],
  recentActionFingerprints: [],
  updatedAt: "t",
});

const contextOf = (index: 0 | 1): CommandSubmissionContext => ({
  _tag: "ExecutionOrigin",
  principal,
  executionId: executionIds[index],
  fencingGeneration: 0 as never,
});

const allowGate: RuntimeSafetyGateService = {
  admitActivity: () => Effect.succeed("Continue" as const),
};

const capability = Layer.succeed(ModelCapabilityPort, {
  resolve: () =>
    Effect.succeed({
      modelRef: "model-a",
      family: "f",
      contextWindow: 8000,
      outputCeiling: 512,
      toolProtocol: "json",
    }),
});

const claimTurn = (claimRef: string) => [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_directive",
    argumentsJson: JSON.stringify({
      _tag: "CompletionClaim",
      claim: { claimRef, workRevision: 0 },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

/** Recording double for the ModelContext port: the minimal observable
 * surface for "which ControlBasis did the driver bind at prepareTurn". */
const recordingModelContext = (recorded: Array<ControlBasis>) =>
  Layer.succeed(ModelContext, {
    prepareTurn: (input: PrepareTurnInput) =>
      Effect.sync(() => {
        recorded.push(input.controlBasis);
        return {
          _tag: "Ready" as const,
          turn: {
            request: {
              modelRef: "model-a",
              instructions: [],
              messages: [],
              toolDefinitions: [],
              outputContractRef: AGENT_DIRECTIVE_CONTRACT,
              budget: { maxOutputTokens: input.maxOutputTokens },
              cacheHints: [],
            },
            manifest: {
              providerTurnId: input.providerTurnId,
              executionId: input.executionId,
              sessionId: input.sessionId,
              contextEpoch: input.contextEpoch,
              modelRef: "model-a",
              instructionFragments: [],
              contextRefs: [],
              skillRefs: [],
              toolRefs: [],
              outputContractRef: AGENT_DIRECTIVE_CONTRACT,
              budgetDecision: { maxOutputTokens: input.maxOutputTokens },
              compiledRequestHash: "hash-p11-controlbasis",
              controlBasis: input.controlBasis,
            },
          },
        };
      }),
  });

const makeApp = () => {
  const recorded: Array<ControlBasis> = [];
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const provider = FakeProviderLive({
    turns: [claimTurn("claim-1"), claimTurn("claim-2")],
  });
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(3),
    Layer.mergeAll(
      provider,
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      infra,
    ),
  );
  const revisions = Layer.provide(EnvironmentRevisionStoreLive, infra);
  const tx = Layer.provide(TransactionPortLive, infra);
  const driver = Layer.provide(
    AgentDriverLive(),
    Layer.mergeAll(
      recordingModelContext(recorded),
      providerRuntime,
      capability,
      Layer.provide(SessionRepositoryLive, infra),
      tx,
      revisions,
    ),
  );
  return {
    app: Layer.mergeAll(
      infra,
      driver,
      providerRuntime,
      capability,
      revisions,
      tx,
    ),
    recorded,
  };
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const [index, sessionId] of sessionIds.entries()) {
        yield* sql.unsafe(
          "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
          [sessionId, "WorkspacePrimary", workspaceIds[index], null, 0, "t"],
        );
      }
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
          workspaceIds[0],
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
      for (const [index, workspaceId] of workspaceIds.entries()) {
        yield* sql.unsafe(
          "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
          [
            workspaceId,
            projectId,
            "w",
            "{}",
            0,
            "{}",
            0,
            "{}",
            sessionIds[index],
            "{}",
            0,
            0,
            "Active",
            "t",
            "t",
          ],
        );
      }
      for (const [index, executionId] of executionIds.entries()) {
        yield* sql.unsafe(
          "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
          [
            executionId,
            projectId,
            "workspace",
            workspaceIds[index],
            "coordination",
            sessionIds[index],
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO execution_leases (execution_id, worker_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?)",
          [executionId, "worker", 0, "9999-12-31T00:00:00.000Z", "t"],
        );
      }
    }),
  );
});

const drive = (index: 0 | 1) =>
  Effect.gen(function* () {
    const driver = yield* ExecutionDriverPort;
    return yield* driver.drive({
      execution: executionOf(index),
      agentExecutionState: stateOf(index),
      wakeReason: { _tag: "WorkSelected" },
      context: contextOf(index),
      safetyGate: allowGate,
    });
  });

const run = <A>(
  program: Effect.Effect<A, any, any>,
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, app) as Effect.Effect<A, any, never>),
  );

describe("P11 GQ4b ControlBasis environmentRevision service-internal read", () => {
  it("binds the preset anchor revision '7' into ControlBasis", async () => {
    const { app, recorded } = makeApp();
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* seed;
        const store = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;
        yield* tx.transact(store.record(projectId, "7"));
        return yield* drive(0);
      }),
      app,
    );
    expect(settlement._tag).toBe("Completed");
    expect(recorded[0]?.environmentRevision).toBe("7");
  });

  it("observes '0' when no anchor exists yet (anchor-uninitialized semantics)", async () => {
    const { app, recorded } = makeApp();
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* seed;
        return yield* drive(0);
      }),
      app,
    );
    expect(settlement._tag).toBe("Completed");
    expect(recorded[0]?.environmentRevision).toBe("0");
  });

  it("carries the advanced revision on the next turn and trips the existing weak freshness gate", async () => {
    const { app, recorded } = makeApp();
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* seed;
        const store = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;
        yield* tx.transact(store.record(projectId, "7"));
        const first = yield* drive(0);
        const advanced = yield* tx.transact(
          store.advanceAnchor(projectId, "7"),
        );
        expect(advanced).toEqual({ _tag: "Advanced", to: "8" });
        const second = yield* drive(1);
        return [first, second];
      }),
      app,
    );
    expect(settlement.map((s) => s._tag)).toEqual(["Completed", "Completed"]);
    expect(recorded[0]?.environmentRevision).toBe("7");
    expect(recorded[1]?.environmentRevision).toBe("8");
    const stale = checkFreshness(
      recorded[0] as ControlBasis,
      recorded[1] as ControlBasis,
      "Weak",
    );
    expect(stale?._tag).toBe("DecisionStale");
    expect(stale?.changed).toContain("environmentRevision");
  });

  it("hardcode removal: driver.ts contains no '\"env\"' literal", () => {
    const source = readFileSync("packages/agent-runtime/src/driver.ts", "utf8");
    expect(source.includes('"env"')).toBe(false);
  });
});
