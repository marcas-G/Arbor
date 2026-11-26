import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P12_MIGRATIONS,
  P36_MIGRATIONS,
  ProjectRepositoryLive,
  RuntimeClockLive,
  runMigrations,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
} from "../../packages/application/src/index.js";
import {
  Actor,
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  makeP2CommandHandlers,
  runRecovery,
} from "../../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionRepository,
  invocationAuthoritySourceRevisionOf,
  ProjectEnvironmentPort,
  ProjectRepository,
  ReconciliationSource,
  ResourceAdmission,
  SandboxPort,
  SessionRepository,
  ToolDefinitionStore,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import {
  ReconciliationSourceLive,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../../packages/tool-runtime/src/index.js";
import { labeled } from "../support/p9-harness-api.js";
import { fileTreeBoundaryJson } from "../support/resource-boundary-fixture.js";
import {
  defectOf,
  durableFile,
  invocationRowOf,
  runOn,
  settleInvocation,
  sqlCount,
} from "./support.js";

// ---------------------------------------------------------------------------
// Story E wiring: the p9-tool-outcome-unknown app with per-tier crash
// points.
// ---------------------------------------------------------------------------

const E_PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789e3");
const E_WORKSPACE = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789e3",
);
const E_SESSION = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789e3");
const E_EXECUTION = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e3",
) as ExecutionId;
const E_ACTOR = parse(Actor)("user:story-e");
const E_PRINCIPAL = parse(Principal)("runtime:system");
const E_TOOL_FENCE = {
  executionId: E_EXECUTION,
  workerId: String(E_PRINCIPAL),
  workerIncarnationId: "incarnation:p9-story-e",
  fencingGeneration: parse(LeaseGeneration)(0),
};

type ETier = "ReadOnly" | "Idempotent" | "Reconcilable" | "NonIdempotent";
type ECrashMode = "before-effect" | "after-effect" | "none";

interface EProbe {
  readonly effects: Array<string>;
}

const E_TOOL_NAMES: Record<ETier, string> = {
  ReadOnly: "probe_ro",
  Idempotent: "probe_idem",
  Reconcilable: "probe_rec",
  NonIdempotent: "probe_non",
};

const E_TIERS: ReadonlyArray<ETier> = [
  "ReadOnly",
  "Idempotent",
  "Reconcilable",
  "NonIdempotent",
];

const eTierDefinition = (tier: ETier) => ({
  name: E_TOOL_NAMES[tier],
  version: "1",
  hash: `probe-${tier}-v1`,
  description: `p9 acceptance tier probe (${tier})`,
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [`probe:${tier}`],
  sideEffectSemantics: tier,
  source: "Builtin" as const,
});

const E_DEFINITIONS = E_TIERS.map(eTierDefinition);

/** Fresh invocation identity per call: a replay would be a NEW invocation
 * row, never the crashed row reused (No.35). */
const E_RO_CRASH = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const E_IDEM = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e2",
);
const E_REC = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e3",
);
const E_NON = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e4",
);
const E_RO_RETRY = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e5",
);

/** Per-tier mutable crash arming: the executor consults the mode on every
 * call so one app can walk all four tiers in sequence. */
const eTierExecutors = (
  probe: EProbe,
  mode: Record<ETier, ECrashMode>,
): ReadonlyArray<ToolExecutor> =>
  E_TIERS.map((tier) => ({
    name: E_TOOL_NAMES[tier],
    write: tier !== "ReadOnly",
    requiresApproval: () => false,
    execute: (input: { readonly intent: { readonly argumentsJson: string } }) =>
      Effect.gen(function* () {
        if (mode[tier] === "before-effect") {
          return yield* Effect.die(
            new Error(`harness-kill:${tier}:pre-effect`),
          );
        }
        probe.effects.push(
          `${E_TOOL_NAMES[tier]}:${input.intent.argumentsJson}`,
        );
        if (mode[tier] === "after-effect") {
          return yield* Effect.die(
            new Error(`harness-kill:${tier}:post-effect`),
          );
        }
        return {
          settlement: { _tag: "Success" as const },
          observation: { text: "ok", truncated: false },
          resultRef: null,
        };
      }),
  }));

const eDefinitionStore = Layer.succeed(ToolDefinitionStore, {
  definition: (name: string, version: string) =>
    Effect.succeed(
      (() => {
        const found = E_DEFINITIONS.find(
          (definition) =>
            definition.name === name && definition.version === version,
        );
        return found === undefined ? Option.none() : Option.some(found);
      })(),
    ),
  all: () => Effect.succeed(E_DEFINITIONS),
});

const eSandbox = Layer.succeed(SandboxPort, {
  open: () =>
    Effect.succeed({ handleId: "p9", rootPath: "/tmp", writableRegions: [] }),
  close: () => Effect.void,
});

const makeStoryEApp = (
  probe: EProbe,
  mode: Record<ETier, ECrashMode>,
  filename: string,
) => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const execRepo = Layer.provide(ExecutionRepositoryLive, infra);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    execRepo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, execRepo)),
    Layer.provide(
      ReconciliationSourceLive,
      Layer.provide(ToolInvocationStoreLive, infra),
    ),
    eDefinitionStore,
    eSandbox,
    Layer.succeed(ResourceAdmission, {
      admit: () => Effect.succeed({ _tag: "Admitted" as const }),
    } as never),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_projectId: unknown, addresses: ReadonlyArray<unknown>) =>
        Effect.succeed({
          regions: addresses.map(
            (
              address,
            ): { resourceSpaceId: string; normalizedRegion: unknown } => ({
              resourceSpaceId: "probe",
              normalizedRegion: address,
            }),
          ),
          observedEnvironmentRevision: "rev",
        }),
    } as never),
    FenceStopCheckInertLive,
  );
  const registry = Layer.provide(
    Layer.effect(
      CommandHandlerRegistry,
      Effect.gen(function* () {
        const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> =
          makeP2CommandHandlers({
            projects: yield* ProjectRepository,
            workspaces: yield* WorkspaceRepository,
            sessions: yield* SessionRepository,
            executions: yield* ExecutionRepository,
            workWaits: yield* WorkWaitStore,
          });
        return CommandHandlerRegistry.of({
          lookup: (commandType) => {
            const handler = handlers.find(
              (candidate) => candidate.commandType === commandType,
            );
            return handler === undefined ? Option.none() : Option.some(handler);
          },
        });
      }),
    ),
    stores,
  );
  const gatewayDeps = Layer.mergeAll(infra, stores, registry);
  return Layer.mergeAll(
    infra,
    stores,
    Layer.provide(
      ToolRuntimeLive(eTierExecutors(probe, mode)),
      Layer.mergeAll(stores, infra),
    ),
    Layer.provide(CommandGatewayLive, gatewayDeps),
  );
};

const seedStoryE = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          E_PROJECT,
          "p9-accept-e",
          E_WORKSPACE,
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?, 'ExecutionScoped', NULL, ?, 0, 't')",
        [E_SESSION, E_EXECUTION],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'w','{}',0,?,0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [E_WORKSPACE, E_PROJECT, fileTreeBoundaryJson(), E_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [E_EXECUTION, E_PROJECT, E_WORKSPACE, E_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?,?)",
        [
          E_EXECUTION,
          String(E_PRINCIPAL),
          "incarnation:p9-story-e",
          0,
          "2999-01-01T00:00:00.000Z",
          "t",
        ],
      );
    }),
  );
});

const eTierContext = (tier: ETier) => {
  const definition = eTierDefinition(tier);
  return {
    executionId: E_EXECUTION,
    workspaceId: E_WORKSPACE,
    sessionId: E_SESSION,
    projectId: E_PROJECT,
    actor: E_ACTOR,
    authenticatedPrincipal: E_PRINCIPAL,
    authority: {
      principal: E_PRINCIPAL,
      workspaceId: E_WORKSPACE,
      executionId: E_EXECUTION,
      toolName: definition.name,
      toolVersion: "1",
      sourceRevision: invocationAuthoritySourceRevisionOf({
        workspacePolicyRevision: 0,
        activeGrants: [],
        verifierId: null,
      }),
      resourceSpaceIds: [],
      allowedCapabilities: definition.capabilityMetadata,
      controlBasisDigest: "d",
      expiresAt: "2999-01-01T00:00:00.000Z",
      delegationDepth: 0,
    },
    controlBasisDigest: "d",
    executionFence: {
      executionId: E_EXECUTION,
      workerId: String(E_PRINCIPAL),
      workerIncarnationId: "incarnation:p9-story-e",
      fencingGeneration: parse(LeaseGeneration)(0),
    },
    requestedAt: "t",
  } as never;
};

const eInvoke = (tier: ETier, invocationId: ToolInvocationId) =>
  Effect.gen(function* () {
    const runtime = yield* ToolRuntimePort;
    return yield* Effect.exit(
      runtime.invoke(
        {
          callRef: `call-${invocationId}`,
          toolName: E_TOOL_NAMES[tier],
          toolVersion: "1",
          argumentsJson: JSON.stringify({ tier }),
          invocationId,
          approvalId: null,
        },
        eTierContext(tier),
      ),
    );
  });

const eDangling = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const store = yield* ToolInvocationStore;
  return yield* tx.transact(store.findUnsettled(E_EXECUTION));
});

const ePending = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const source = yield* ReconciliationSource;
  return yield* tx.transact(source.pending(E_EXECUTION));
});

const eRequestStop = Effect.gen(function* () {
  const repo = yield* ExecutionRepository;
  const tx = yield* TransactionPort;
  const clock = yield* Clock;
  const now = yield* clock.now();
  yield* tx.transact(repo.requestStop(E_EXECUTION, now));
});

const eEscalationFacts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?",
    [E_EXECUTION],
  );
  // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
  return Number(rows[0]!.count);
});

const eExecutionRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
    "SELECT settlement_kind FROM executions WHERE execution_id = ?",
    [E_EXECUTION],
  );
  return rows[0] ?? null;
});

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe("p9-acceptance", () => {
  it("Story E (06 §E) [crash-injected]: tool four tiers — dangling detected for all, ReadOnly retries clean, Idempotent same-identity no-duplicate-effect, Reconcilable reconcile-then-settle, NonIdempotent NEVER auto-replayed and the execution NEVER settles Interrupted", async () => {
    expect(labeled("story-E-tool-four-tiers", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const probe: EProbe = { effects: [] };
    const mode: Record<ETier, ECrashMode> = {
      ReadOnly: "before-effect",
      Idempotent: "after-effect",
      Reconcilable: "after-effect",
      NonIdempotent: "after-effect",
    };
    await runOn(
      Effect.gen(function* () {
        // Story E executes the current P4 tool pipeline: preserve its P12
        // fixture start and upgrade it before admission-state reads/writes.
        yield* runMigrations(P12_MIGRATIONS);
        yield* runMigrations(P36_MIGRATIONS);
        yield* seedStoryE;
        // ReadOnly: crash before the effect — nothing happened externally;
        // the crashed invocation settles the actual (no-op) outcome and a
        // clean retry under a fresh identity settles Success.
        const roCrash = yield* eInvoke("ReadOnly", E_RO_CRASH);
        expect((defectOf(roCrash) as Error).message).toBe(
          "harness-kill:ReadOnly:pre-effect",
        );
        const danglingRo = yield* eDangling;
        expect(danglingRo).toHaveLength(1);
        // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
        expect(danglingRo[0]!.sideEffectSemantics).toBe("ReadOnly");
        yield* settleInvocation(E_RO_CRASH, E_TOOL_FENCE);
        mode.ReadOnly = "none";
        const roRetry = yield* eInvoke("ReadOnly", E_RO_RETRY);
        expect(roRetry._tag).toBe("Success");
        yield* settleInvocation(E_RO_RETRY, E_TOOL_FENCE);
        expect(probe.effects).toHaveLength(1);
        // Idempotent: crash after the effect; the same-identity settlement
        // write replays as a no-op — exactly one row, one external effect.
        const idemCrash = yield* eInvoke("Idempotent", E_IDEM);
        expect((defectOf(idemCrash) as Error).message).toBe(
          "harness-kill:Idempotent:post-effect",
        );
        yield* settleInvocation(E_IDEM, E_TOOL_FENCE);
        const idemRowOnce = yield* invocationRowOf(E_IDEM);
        yield* settleInvocation(E_IDEM, E_TOOL_FENCE);
        const idemRowTwice = yield* invocationRowOf(E_IDEM);
        expect(idemRowTwice).toEqual(idemRowOnce);
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
            [E_IDEM],
          ),
        ).toBe(1);
        expect(probe.effects).toHaveLength(2);
        // NonIdempotent: ambiguity escalates — never automatic replay.
        const nonCrash = yield* eInvoke("NonIdempotent", E_NON);
        expect((defectOf(nonCrash) as Error).message).toBe(
          "harness-kill:NonIdempotent:post-effect",
        );
        // Reconcilable runs while the Execution is still admitting effects;
        // the later Stop is fenced against new invocation admission.
        const recCrash = yield* eInvoke("Reconcilable", E_REC);
        expect((defectOf(recCrash) as Error).message).toBe(
          "harness-kill:Reconcilable:post-effect",
        );
        yield* eRequestStop;
        const pendingAll = yield* ePending;
        expect([...pendingAll].map(String).sort()).toEqual(
          [String(E_NON), String(E_REC)].sort(),
        );
        const pass1 = yield* runRecovery(E_PRINCIPAL);
        expect(pass1.settled).toEqual([]);
        expect(pass1.escalated).toEqual([E_EXECUTION]);
        // Both unresolved side effects share one initial escalation fact.
        expect(yield* eEscalationFacts).toBe(1);
        expect(probe.effects).toHaveLength(4);
        // Reconcilable: reconcile-then-settle is the only unlock.
        yield* settleInvocation(E_REC, E_TOOL_FENCE);
        const pass2 = yield* runRecovery(E_PRINCIPAL);
        expect(pass2.settled).toEqual([]);
        expect(pass2.escalated).toEqual([E_EXECUTION]);
        // The remaining [non] fingerprint adds one fact and then dedupes.
        expect(yield* eEscalationFacts).toBe(2);
        const pass3 = yield* runRecovery(E_PRINCIPAL);
        expect(pass3.settled).toEqual([]);
        expect(pass3.escalated).toEqual([E_EXECUTION]);
        expect(yield* eEscalationFacts).toBe(2);
        // Final tier ledger: no replay ever (one row per identity), the
        // NonIdempotent invocation stays reconciling, the Execution never
        // settles plain Interrupted/Completed/Failed.
        expect(
          yield* sqlCount("SELECT COUNT(*) AS count FROM tool_invocations"),
        ).toBe(5);
        const finalExecution = yield* eExecutionRow;
        expect(finalExecution?.settlement_kind).toBeNull();
        expect(finalExecution?.settlement_kind).not.toBe("Interrupted");
        const nonRow = yield* invocationRowOf(E_NON);
        expect(nonRow?.settled_at).toBeNull();
        expect(nonRow?.settlement_kind).toBeNull();
        const danglingFinal = yield* eDangling;
        expect(danglingFinal).toHaveLength(1);
        // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
        expect(danglingFinal[0]!.sideEffectSemantics).toBe("NonIdempotent");
        expect(probe.effects).toHaveLength(4);
      }),
      makeStoryEApp(probe, mode, durableFile("e")),
    );
  });
});
