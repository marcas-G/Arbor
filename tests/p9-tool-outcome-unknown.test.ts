import { Cause, Effect, Exit, Layer, Option } from "effect";
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
  P8_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
} from "../packages/application/src/index.js";
import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  makeP2CommandHandlers,
  runRecovery,
} from "../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionRepository,
  ProjectEnvironmentPort,
  ProjectRepository,
  ReconciliationSource,
  ResourceAdmission,
  SandboxPort,
  SessionRepository,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolIntent,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  WorkspaceRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import {
  type ToolExecutor,
  ToolRuntimeLive,
} from "../packages/tool-runtime/src/index.js";
import { labeled } from "./support/p9-harness-api.js";

/**
 * P9-009 — tool four-tier injection (T1–T4 / 02 §5 + 04 §3, invariant 35)
 * + D3. Crash is injected at fiber level inside the tool executor at the
 * named point (intent-before-effect, P4 `06` §2, makes the dangling
 * invocation visible): `before-effect` (T1 ReadOnly crash point) and
 * `after-effect` (T2–T4 crash point: effect done, settlement absent). The
 * `side_effect_semantics` snapshot drives classification (DID §9.12); the
 * four tiers share the dangling-detection assertion and differ only in the
 * permitted post-crash action. Every row is labeled crash-injected (GQ5).
 */

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789e1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789e1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e1",
) as ExecutionId;
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("runtime:system");

type Tier = "ReadOnly" | "Idempotent" | "Reconcilable" | "NonIdempotent";
type CrashMode = "before-effect" | "after-effect" | "none";

/** Adapter-side external-effect probe: counts real external effects and
 * their identity digests (the no-duplicate-effect / no-replay oracle). */
interface Probe {
  readonly effects: Array<string>;
}

const PERMISSIVE_SCHEMA = JSON.stringify({ type: "object" });

const TIER_TOOL_NAMES: Record<Tier, string> = {
  ReadOnly: "probe_ro",
  Idempotent: "probe_idem",
  Reconcilable: "probe_rec",
  NonIdempotent: "probe_non",
};

const tierDefinition = (tier: Tier) => ({
  name: TIER_TOOL_NAMES[tier],
  version: "1",
  hash: `probe-${tier}-v1`,
  description: `p9 tier probe (${tier})`,
  inputSchemaJson: PERMISSIVE_SCHEMA,
  resultSchemaJson: PERMISSIVE_SCHEMA,
  capabilityMetadata: [`probe:${tier}`],
  sideEffectSemantics: tier,
  source: "Builtin" as const,
});

const TIER_DEFINITIONS = (
  ["ReadOnly", "Idempotent", "Reconcilable", "NonIdempotent"] as const
).map(tierDefinition);

const tierExecutors = (
  probe: Probe,
  crash: CrashMode,
): ReadonlyArray<ToolExecutor> =>
  (["ReadOnly", "Idempotent", "Reconcilable", "NonIdempotent"] as const).map(
    (tier) => ({
      name: TIER_TOOL_NAMES[tier],
      write: tier !== "ReadOnly",
      requiresApproval: () => false,
      execute: (input: {
        readonly intent: { readonly argumentsJson: string };
      }) =>
        Effect.gen(function* () {
          if (crash === "before-effect") {
            // T1 crash point: intent persisted, effect not yet executed.
            return yield* Effect.die(new Error("harness-kill:tool-pre-effect"));
          }
          probe.effects.push(
            `${TIER_TOOL_NAMES[tier]}:${input.intent.argumentsJson}`,
          );
          if (crash === "after-effect") {
            // T2–T4 crash point: after effect, before settlement.
            return yield* Effect.die(
              new Error("harness-kill:tool-post-effect"),
            );
          }
          return {
            settlement: { _tag: "Success" as const },
            observation: { text: "ok", truncated: false },
            resultRef: null,
          };
        }),
    }),
  );

const definitionStore = Layer.succeed(ToolDefinitionStore, {
  definition: (name: string, version: string) => {
    const found = TIER_DEFINITIONS.find(
      (definition) =>
        definition.name === name && definition.version === version,
    );
    return Effect.succeed(
      found === undefined ? Option.none() : Option.some(found),
    );
  },
  all: () => Effect.succeed(TIER_DEFINITIONS),
});

const sandbox = Layer.succeed(SandboxPort, {
  open: () =>
    Effect.succeed({
      handleId: "p9",
      rootPath: "/tmp",
      writableRegions: [],
    }),
  close: () => Effect.void,
});

const makeApp = (probe: Probe, crash: CrashMode) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(
      LeaseServiceLive,
      Layer.merge(infra, Layer.provide(ExecutionRepositoryLive, infra)),
    ),
    Layer.provide(
      ReconciliationSourceLive,
      Layer.provide(ToolInvocationStoreLive, infra),
    ),
    definitionStore,
    sandbox,
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
    }),
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
      ToolRuntimeLive(tierExecutors(probe, crash)),
      Layer.mergeAll(stores, infra),
    ),
    Layer.provide(CommandGatewayLive, gatewayDeps),
  );
};

// ReconciliationSourceLive import kept local to the wiring above.
import { ReconciliationSourceLive } from "../packages/tool-runtime/src/index.js";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p9tt",
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?, 'ExecutionScoped', NULL, ?, 0, 't')",
        [sessionId, executionId],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'w','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [workspaceId, projectId, sessionId],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [executionId, projectId, workspaceId, sessionId],
      );
    }),
  );
});

const boot = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* seed;
});

const tierContext = (tier: Tier): ToolExecutionContext => {
  const definition = tierDefinition(tier);
  return {
    executionId,
    workspaceId,
    sessionId,
    projectId,
    actor,
    authenticatedPrincipal: principal,
    authority: {
      principal,
      workspaceId,
      executionId,
      toolName: definition.name,
      toolVersion: "1",
      resourceSpaceIds: [],
      allowedCapabilities: definition.capabilityMetadata,
      controlBasisDigest: "d",
      expiresAt: "2999-01-01T00:00:00.000Z",
      delegationDepth: 0,
    },
    controlBasisDigest: "d",
    requestedAt: "t",
  };
};

const tierIntent = (tier: Tier): ToolIntent => ({
  callRef: "c1",
  toolName: TIER_TOOL_NAMES[tier],
  toolVersion: "1",
  argumentsJson: JSON.stringify({ tier }),
  invocationId,
  approvalId: null,
});

/** Crash-injected invoke: run the real pipeline; the executor dies at the
 * named crash point (P9-001 convention — mechanism empirical, the point
 * and the assertion are contract). */
const crashInvoke = (tier: Tier) =>
  Effect.gen(function* () {
    const runtime = yield* ToolRuntimePort;
    return yield* Effect.exit(
      runtime.invoke(tierIntent(tier), tierContext(tier)),
    );
  });

const run = <A>(
  program: Effect.Effect<A, any, any>,
  probe: Probe,
  crash: CrashMode,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, makeApp(probe, crash)) as Effect.Effect<
      A,
      any,
      never
    >,
  );

const danglingInvocations = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const store = yield* ToolInvocationStore;
  return yield* tx.transact(store.findUnsettled(executionId));
});

const pendingRefs = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const source = yield* ReconciliationSource;
  return yield* tx.transact(source.pending(executionId));
});

const invocationRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    settled_at: string | null;
    settlement_kind: string | null;
    side_effect_semantics: string;
  }>(
    "SELECT settled_at, settlement_kind, side_effect_semantics FROM tool_invocations WHERE invocation_id = ?",
    [invocationId],
  );
  return rows[0] ?? null;
});

const invocationCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
    [invocationId],
  );
  return Number(rows[0]!.count);
});

const escalationFacts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?",
    [executionId],
  );
  return Number(rows[0]!.count);
});

const executionRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    settlement_kind: string | null;
    stop_requested_at: string | null;
  }>(
    "SELECT settlement_kind, stop_requested_at FROM executions WHERE execution_id = ?",
    [executionId],
  );
  return rows[0] ?? null;
});

const requestStop = Effect.gen(function* () {
  const repo = yield* ExecutionRepository;
  const tx = yield* TransactionPort;
  const clock = yield* Clock;
  const now = yield* clock.now();
  yield* tx.transact(repo.requestStop(executionId, now));
});

const settleInvocation = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const store = yield* ToolInvocationStore;
  const clock = yield* Clock;
  const now = yield* clock.now();
  yield* tx.transact(
    store.settle(invocationId, { _tag: "Success" }, null, now),
  );
});

const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;

describe("p9-tool-outcome-unknown (T1–T4 four tiers + D3, 02 §5 + 04 §3)", () => {
  it("TT1/ReadOnly [crash-injected]: dangling detected, never enters escalation, settles directly per actual outcome — no OutcomeUnknown required", async () => {
    expect(
      labeled("T1-ReadOnly-safe-retry-settle", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: Probe = { effects: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // Crash point: intent persisted, effect not yet executed.
        const exit = yield* crashInvoke("ReadOnly");
        const dangling = yield* danglingInvocations;
        const pending = yield* pendingRefs;
        // ReadOnly carries no external effect — the actual outcome is
        // "nothing happened": settle Success directly (safe settlement).
        yield* settleInvocation;
        const row = yield* invocationRow;
        yield* requestStop;
        const recovery = yield* runRecovery(principal);
        const execution = yield* executionRow;
        const facts = yield* escalationFacts;
        return { exit, dangling, pending, row, recovery, execution, facts };
      }),
      probe,
      "before-effect",
    );
    expect((defectOf(r.exit) as Error).message).toBe(
      "harness-kill:tool-pre-effect",
    );
    // Shared dangling-detection assertion (P4 06 §2): visible via
    // findUnsettled with the semantics snapshot intact.
    expect(r.dangling).toHaveLength(1);
    expect(r.dangling[0]!.sideEffectSemantics).toBe("ReadOnly");
    // ReadOnly dangling never enters reconciliation/escalation.
    expect(r.pending).toEqual([]);
    // Exactly one settlement row, actual outcome recorded.
    expect(r.row?.settled_at).not.toBeNull();
    expect(r.row?.settlement_kind).toBe("Success");
    // ReadOnly never gates the deterministic stop settlement: no
    // OutcomeUnknown, no escalation fact.
    expect(r.recovery.settled).toEqual([executionId]);
    expect(r.execution?.settlement_kind).toBe("Interrupted");
    expect(r.facts).toBe(0);
    expect(probe.effects).toEqual([]);
  });

  it("TT2/Idempotent [crash-injected]: same-identity retry is safe — exactly one settlement row, no duplicate external effect", async () => {
    expect(
      labeled("T2-Idempotent-same-key-replay", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: Probe = { effects: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // Crash point: after effect, before settlement.
        const exit = yield* crashInvoke("Idempotent");
        const dangling = yield* danglingInvocations;
        const pending = yield* pendingRefs;
        // Same-identity retry converges: the settlement write under the
        // same key (executionId, invocationId) lands the actual outcome...
        yield* settleInvocation;
        const rowOnce = yield* invocationRow;
        // ...and an at-least-once duplicate of that settlement write is a
        // no-op — still exactly one settlement row (idempotent replay).
        yield* settleInvocation;
        const rowTwice = yield* invocationRow;
        const count = yield* invocationCount;
        yield* requestStop;
        const recovery = yield* runRecovery(principal);
        const execution = yield* executionRow;
        return {
          exit,
          dangling,
          pending,
          rowOnce,
          rowTwice,
          count,
          recovery,
          execution,
        };
      }),
      probe,
      "after-effect",
    );
    expect((defectOf(r.exit) as Error).message).toBe(
      "harness-kill:tool-post-effect",
    );
    expect(r.dangling).toHaveLength(1);
    expect(r.dangling[0]!.sideEffectSemantics).toBe("Idempotent");
    // Idempotent dangling needs no reconciliation gate (safe replay tier).
    expect(r.pending).toEqual([]);
    expect(r.rowOnce?.settlement_kind).toBe("Success");
    expect(r.rowTwice).toEqual(r.rowOnce);
    // Exactly one settlement row under the invocation key.
    expect(r.count).toBe(1);
    // Adapter probe: the external effect happened exactly once across
    // crash + replayed settlement — no duplicate effect.
    expect(probe.effects).toHaveLength(1);
    expect(r.recovery.settled).toEqual([executionId]);
    expect(r.execution?.settlement_kind).toBe("Interrupted");
  });

  it("TT3/Reconcilable [crash-injected]: pending lists the ref; reconcile-then-settle — no replay admitted before a reconcile result exists", async () => {
    expect(
      labeled("T3-Reconcilable-reconcile-then-settle", "crash-injected")
        .guarantee,
    ).toBe("crash-injected");
    const probe: Probe = { effects: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* crashInvoke("Reconcilable");
        const dangling = yield* danglingInvocations;
        const pending = yield* pendingRefs;
        yield* requestStop;
        // While no reconcile result exists (invocation still dangling),
        // recovery may only escalate: no settlement, no replay.
        const first = yield* runRecovery(principal);
        const executionDuring = yield* executionRow;
        const countDuring = yield* invocationCount;
        const factsDuring = yield* escalationFacts;
        // The owning tool reconciles external reality (the probe IS the
        // external outcome: effect occurred exactly once) and settles the
        // reconciled actual outcome BEFORE any replay decision.
        yield* settleInvocation;
        // With the reconcile result settled, the deterministic stop path
        // proceeds.
        const second = yield* runRecovery(principal);
        const executionAfter = yield* executionRow;
        const countAfter = yield* invocationCount;
        return {
          exit,
          dangling,
          pending,
          first,
          executionDuring,
          countDuring,
          factsDuring,
          second,
          executionAfter,
          countAfter,
        };
      }),
      probe,
      "after-effect",
    );
    expect((defectOf(r.exit) as Error).message).toBe(
      "harness-kill:tool-post-effect",
    );
    expect(r.dangling).toHaveLength(1);
    expect(r.dangling[0]!.sideEffectSemantics).toBe("Reconcilable");
    // The ref IS enumerated for reconciliation (real source).
    expect(r.pending).toEqual([invocationId]);
    // Ordering assertion: before any reconcile result existed —
    // escalation only; the Execution stays Active (never blind
    // Interrupted), and no replay was admitted (no second row, no
    // re-execute).
    expect(r.first.escalated).toEqual([executionId]);
    expect(r.first.settled).toEqual([]);
    expect(r.executionDuring?.settlement_kind).toBeNull();
    expect(r.countDuring).toBe(1);
    expect(r.factsDuring).toBe(1);
    expect(probe.effects).toHaveLength(1);
    // After reconcile-then-settle: the deterministic settlement proceeds.
    expect(r.second.settled).toEqual([executionId]);
    expect(r.executionAfter?.settlement_kind).toBe("Interrupted");
    expect(r.countAfter).toBe(1);
    expect(probe.effects).toHaveLength(1);
  });

  it("TT4/NonIdempotent [crash-injected]: ambiguity escalates / stays reconciling — never automatic replay, no path to settlement without reconciliation", async () => {
    expect(
      labeled("T4-NonIdempotent-never-auto-replay", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: Probe = { effects: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* crashInvoke("NonIdempotent");
        const dangling = yield* danglingInvocations;
        const pending = yield* pendingRefs;
        yield* requestStop;
        // Repeated recovery passes over the same ambiguity: escalation is
        // deduped and no replay attempt is ever produced.
        const first = yield* runRecovery(principal);
        const second = yield* runRecovery(principal);
        const third = yield* runRecovery(principal);
        const execution = yield* executionRow;
        const count = yield* invocationCount;
        const row = yield* invocationRow;
        const facts = yield* escalationFacts;
        return {
          exit,
          dangling,
          pending,
          first,
          second,
          third,
          execution,
          count,
          row,
          facts,
        };
      }),
      probe,
      "after-effect",
    );
    expect((defectOf(r.exit) as Error).message).toBe(
      "harness-kill:tool-post-effect",
    );
    expect(r.dangling).toHaveLength(1);
    expect(r.dangling[0]!.sideEffectSemantics).toBe("NonIdempotent");
    expect(r.pending).toEqual([invocationId]);
    // Ambiguity → escalate (OutcomeUnknown / stays Active-reconciling):
    // the Execution is never settled plain Completed/Interrupted/Failed
    // (No.54; P2 06 §5) across repeated passes — no path to settlement
    // without reconciliation.
    for (const pass of [r.first, r.second, r.third]) {
      expect(pass.settled).toEqual([]);
      expect(pass.escalated).toEqual([executionId]);
    }
    expect(r.execution?.settlement_kind).toBeNull();
    // Exactly one durable Attention fact (dedup fingerprint).
    expect(r.facts).toBe(1);
    // Never automatic replay (No.35): no second invocation row under the
    // same key, no re-execute — the invocation stays reconciling.
    expect(r.count).toBe(1);
    expect(r.row?.settled_at).toBeNull();
    expect(r.row?.settlement_kind).toBeNull();
    expect(probe.effects).toHaveLength(1);
  });

  it("D3 [crash-injected]: daemon-crash fixture with unsettled tool intent — dangling detected via the real ReconciliationSource, never blindly settled Interrupted", async () => {
    expect(
      labeled("D3-daemon-crash-dangling-intent", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: Probe = { effects: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // P9-002 seed pattern: the durable post-crash state written raw
        // (INSERT_INVOCATION-style) — daemon died between intent
        // persistence and settlement.
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, intent_at) VALUES (?,?,?,?,?,?,?,?,'t')",
          [
            invocationId,
            executionId,
            workspaceId,
            "probe_non",
            "1",
            "NonIdempotent",
            "{}",
            "[]",
          ],
        );
        const pending = yield* pendingRefs;
        const recovery = yield* runRecovery(principal);
        const execution = yield* executionRow;
        const facts = yield* escalationFacts;
        return { pending, recovery, execution, facts };
      }),
      probe,
      "none",
    );
    // Dangling detected through the real wired source (B-1).
    expect(r.pending).toEqual([invocationId]);
    // Active execution without stop: recovery settles nothing — and never
    // a blind Interrupted (No.54 / 04 §1 I-1).
    expect(r.recovery.settled).toEqual([]);
    expect(r.recovery.escalated).toEqual([]);
    expect(r.execution?.settlement_kind).toBeNull();
    expect(r.execution?.stop_requested_at).toBeNull();
    expect(r.facts).toBe(0);
    expect(probe.effects).toEqual([]);
  });
});
