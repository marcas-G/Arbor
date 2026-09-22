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
  ProviderTurnStoreLive,
  runMigrations,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  makeSelectCurrentWorkHandler,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  type LeaseGeneration,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  Revision,
  SessionId,
  ToolInvocationId,
  WorkId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  FenceStopCheckLive,
  makeP2CommandHandlers,
  runRecovery,
  type SettleExecutionPayload,
} from "../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionRepository,
  type LeaseFencingRejected,
  LeaseService,
  ProjectRepository,
  ProviderTurnStore,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import { ReconciliationSourceLive } from "../packages/tool-runtime/src/index.js";
import { labeled } from "./support/p9-harness-api.js";

/**
 * P9-006 — worker crash (W1–W5) + old-worker resurrection (R1–R6) injection
 * matrix (P9 `02` §1/§2). Crash = worker-level die at the named point
 * (P9-001 harness convention: mechanism empirical, the point and the
 * assertion are contract). Every case is labeled crash-injected (GQ5).
 */

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789b1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789b1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
) as ExecutionId;
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("runtime:system");
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const toolInvocationId = (n: number) =>
  parse(ToolInvocationId)(
    `tin_018f2b3c-4d5e-7abc-8def-0123456789${String(n).padStart(2, "0")}`,
  );

let commandSeq = 0;
const nextCommandId = () => {
  commandSeq += 1;
  return parse(CommandId)(
    `cmd_018f2b3c-4d5e-7abc-8def-0123456789${String(commandSeq).padStart(2, "0")}`,
  );
};

const P9CommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | ExecutionRepository
  | WorkWaitStore
  | WorkRepository
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP2CommandHandlers({
        projects: yield* ProjectRepository,
        workspaces: yield* WorkspaceRepository,
        sessions: yield* SessionRepository,
        executions: yield* ExecutionRepository,
        workWaits: yield* WorkWaitStore,
      }),
      makeSelectCurrentWorkHandler({
        workspaces: yield* WorkspaceRepository,
        works: yield* WorkRepository,
        executions: yield* ExecutionRepository,
      }) as unknown as CommandHandler<unknown, unknown>,
    ];
    return CommandHandlerRegistry.of({
      lookup: (commandType) => {
        const handler = handlers.find(
          (candidate) => candidate.commandType === commandType,
        );
        return handler === undefined ? Option.none() : Option.some(handler);
      },
    });
  }),
);

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
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
    Layer.provide(ProviderTurnStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(
      ReconciliationSourceLive,
      Layer.provide(ToolInvocationStoreLive, infra),
    ),
    execRepo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, execRepo)),
    Layer.provide(FenceStopCheckLive, Layer.merge(infra, execRepo)),
  );
  const all = Layer.mergeAll(
    infra,
    stores,
    Layer.provide(P9CommandHandlerRegistryLive, stores),
  );
  return Layer.mergeAll(all, Layer.provide(CommandGatewayLive, all));
};

/** P9-002 seed pattern: raw durable state (project/session/workspace/work +
 * admitted Active execution), lease rows driven only by the production
 * LeaseService / ExecutionRepository faces. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p9",
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
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Open',0,'t','t')",
        [
          workId,
          projectId,
          workspaceId,
          "p9",
          "seed",
          "[]",
          "green",
          '{"goal":"g","criteria":[],"riskRequirements":[]}',
          '{"predecessorWorkId":null,"reason":"seed"}',
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [executionId, projectId, workspaceId, sessionId],
      );
    }),
  );
});

const clockNow = Effect.gen(function* () {
  const clock = yield* Clock;
  return yield* clock.now();
});

const sqlCount = (text: string, params: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(text, params);
    return Number(rows[0]?.count ?? 0);
  });

const executionState = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    settled_at: string | null;
    settlement_kind: string | null;
  }>(
    "SELECT settled_at, settlement_kind FROM executions WHERE execution_id = ?",
    [executionId],
  );
  return rows[0] ?? null;
});

const leaseRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    worker_id: string;
    generation: number;
    expires_at: string;
  }>(
    "SELECT worker_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
    [executionId],
  );
  return rows[0] ?? null;
});

const workOpen = sqlCount(
  "SELECT COUNT(*) AS count FROM works WHERE work_id = ? AND lifecycle = 'Open'",
  [workId],
);

const eventsOf = (type: string) =>
  sqlCount("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?", [
    type,
  ]);

const acquireLease = (workerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx.transact(leases.acquire(executionId, workerId));
  });

/** Expire the live lease in place via the production release CAS (sets
 * expires_at = now): the CI approximation of TTL passage. */
const expireInPlace = (workerId: string, generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repo = yield* ExecutionRepository;
    yield* tx.transact(repo.releaseLease(executionId, workerId, generation));
  });

const settleViaGateway = (
  generation: LeaseGeneration,
  settlement: SettleExecutionPayload["settlement"],
) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const commandId = nextCommandId();
    const payload: SettleExecutionPayload = {
      executionId,
      settlement,
      expectedFencingGeneration: generation,
    };
    return yield* gw.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId,
        actor,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal,
        executionId,
        fencingGeneration: generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId,
          actor,
          schemaVersion: "1",
          payload,
        }),
        projectId,
        commandKind: "SettleExecution",
        executionId,
        fencingGeneration: generation,
      },
    );
  });

const selectCurrentWorkViaGateway = (
  commandId: CommandId,
  generation: LeaseGeneration,
) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const payload = {
      workspaceId,
      workId,
      expectedWorkspaceRevision: parse(Revision)(0),
    };
    const authority: VerifiedCommandAuthority = {
      _tag: "SelectCurrentWorkAuthority",
      principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SelectCurrentWork",
        projectId,
        actor,
        schemaVersion: "1",
        payload,
      }),
      projectId,
      targetWorkspaceId: workspaceId,
    };
    return yield* gw.execute(
      {
        commandType: "SelectCurrentWork",
        commandId,
        projectId,
        actor,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal,
        executionId,
        fencingGeneration: generation,
      } satisfies CommandSubmissionContext,
      authority,
    );
  });

const openProviderTurn = (turnId: ProviderTurnId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const turns = yield* ProviderTurnStore;
    yield* tx.transact(
      turns.startTurn(
        {
          providerTurnId: turnId,
          executionId,
          sessionId,
          contextEpoch: 0 as never,
          modelRef: "provider-fake",
          outputContractRef: "oc",
          manifestId: "mf",
        },
        "t",
      ),
    );
  });

const recordToolIntent = (invocationId: ToolInvocationId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const tools = yield* ToolInvocationStore;
    yield* tx.transact(
      tools.recordIntent({
        invocationId,
        executionId,
        workspaceId,
        toolName: "shell",
        toolVersion: "1",
        sideEffectSemantics: "NonIdempotent",
        argumentsJson: "{}",
        resolvedRegions: [],
        approvalId: null,
        intentAt: "t",
      }),
    );
  });

/** P2 `03` §3 fence predicate — identical read face to the fenced Session
 * append; composed with the write in ONE transaction (02 §2 note). */
const leaseFenceHolds = (generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const now = yield* clockNow;
    const rows = yield* sql
      .unsafe<{ ok: number }>(
        "SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL",
        [executionId, generation, now],
      )
      .pipe(Effect.orDie);
    return rows.length > 0;
  });

const leaseFencingRejected = (
  generation: LeaseGeneration,
): LeaseFencingRejected => ({
  _tag: "LeaseFencingRejected",
  executionId,
  generation,
});

const withLeaseFence = <A, E, R>(
  generation: LeaseGeneration,
  write: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LeaseFencingRejected, R | Clock | SqlClient> =>
  Effect.gen(function* () {
    const holds = yield* leaseFenceHolds(generation);
    if (!holds) {
      return yield* Effect.fail(leaseFencingRejected(generation));
    }
    return yield* write;
  });

const completed: SettleExecutionPayload["settlement"] = {
  _tag: "Completed",
  result: { _tag: "CoordinationCompleted" },
};

/** Worker lifecycle mirroring `runExecution`'s durable sequence with a
 * harness kill point at each W-row position (P9-001 convention:
 * `harness-kill:<point>` defect = worker loss, CI approximation). */
const workerRun = (
  workerId: string,
  point: string | null,
  turnId: ProviderTurnId,
  invocationId: ToolInvocationId,
) => {
  const kill = (at: string): Effect.Effect<void> =>
    point !== null && at === point
      ? Effect.die(new Error(`harness-kill:${at}`))
      : Effect.void;
  return Effect.gen(function* () {
    // dispatch accepted (ticket in memory only)
    yield* kill("W1");
    const lease = yield* acquireLease(workerId);
    yield* kill("W2");
    yield* openProviderTurn(turnId);
    yield* recordToolIntent(invocationId);
    yield* kill("W3");
    yield* kill("W5");
    const settlement = completed;
    yield* kill("W4");
    return yield* settleViaGateway(lease.generation, settlement);
  });
};

const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;

const run = <A>(program: Effect.Effect<A, any, any>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, makeApp()) as Effect.Effect<A, any, never>,
  );

const boot = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* seed;
});

/** Fixture: new worker re-acquired at generation g+1; the old worker (g)
 * resurrects and writes across the fencing surface (02 §2). */
const takeover = Effect.gen(function* () {
  const old = yield* acquireLease("worker:a");
  yield* expireInPlace("worker:a", old.generation);
  const next = yield* acquireLease("worker:b");
  return { old: old.generation, current: next.generation };
});

describe("p9-worker-crash (W1–W5, 02 §1)", () => {
  it("W1 [crash-injected]: kill at dispatch-accepted-before-lease — no lease row, Execution unchanged, re-dispatch converges", async () => {
    expect(labeled("W1-pre-lease", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W1", providerTurnId, toolInvocationId(1)),
        );
        const lease = yield* leaseRow;
        const exec = yield* executionState;
        const redispatch = yield* acquireLease("worker:redisp");
        const receipt = yield* settleViaGateway(
          redispatch.generation,
          completed,
        );
        const execAfter = yield* executionState;
        return { exit, lease, exec, redispatch, receipt, execAfter };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W1");
    expect(r.lease).toBeNull();
    expect(r.exec?.settled_at).toBeNull();
    expect(r.exec?.settlement_kind).toBeNull();
    expect(Number(r.redispatch.generation)).toBe(0);
    expect(
      (r.receipt as { resolution: { _tag: string } }).resolution._tag,
    ).toBe("Committed");
    expect(r.execAfter?.settlement_kind).toBe("Completed");
  });

  it("W2 [crash-injected]: kill after lease acquire before drive — live lease until TTL, no Active→Settled, lazy invalidation enables takeover", async () => {
    expect(labeled("W2-post-lease-pre-drive", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W2", providerTurnId, toolInvocationId(1)),
        );
        const lease = yield* leaseRow;
        const now = yield* clockNow;
        const exec = yield* executionState;
        yield* expireInPlace("worker:a", 0 as never);
        const sweepNow = yield* clockNow;
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const invalidated = yield* tx.transact(
          leases.invalidateExpired(sweepNow),
        );
        const takeoverLease = yield* acquireLease("worker:b");
        const execAfter = yield* executionState;
        return {
          exit,
          lease,
          now,
          exec,
          invalidated,
          takeoverLease,
          execAfter,
        };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W2");
    expect(r.lease?.worker_id).toBe("worker:a");
    expect(Number(r.lease?.generation)).toBe(0);
    expect(r.lease !== null && r.lease.expires_at > r.now).toBe(true);
    expect(r.exec?.settled_at).toBeNull();
    expect(r.invalidated).toBe(1);
    expect(Number(r.takeoverLease.generation)).toBe(1);
    expect(r.execAfter?.settled_at).toBeNull();
  });

  it("W3 [crash-injected]: kill mid-drive — dangling intents, lazy takeover at generation+1, single authoritative resolution", async () => {
    expect(labeled("W3-mid-drive-takeover", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W3", providerTurnId, toolInvocationId(1)),
        );
        const danglingTurns = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM provider_turns WHERE execution_id = ? AND settled_at IS NULL",
          [executionId],
        );
        const tx = yield* TransactionPort;
        const tools = yield* ToolInvocationStore;
        const danglingInvocations = (yield* tx.transact(
          tools.findUnsettled(executionId),
        )).length;
        const exec = yield* executionState;
        yield* expireInPlace("worker:a", 0 as never);
        const takeoverLease = yield* acquireLease("worker:b");
        const sessions = yield* SessionRepository;
        const sameLogicalContent = {
          entryKind: "ModelOutput" as const,
          payload: { text: "turn-final" },
        };
        const takeoverAppend = yield* tx.transact(
          sessions.appendEntry(sessionId, sameLogicalContent, {
            executionId,
            fencingGeneration: takeoverLease.generation,
          }),
        );
        const lateAppend = yield* tx
          .transact(
            sessions.appendEntry(sessionId, sameLogicalContent, {
              executionId,
              fencingGeneration: 0 as never,
            }),
          )
          .pipe(Effect.flip);
        const entryCount = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
          [sessionId],
        );
        const receipt = yield* settleViaGateway(
          takeoverLease.generation,
          completed,
        );
        const execAfter = yield* executionState;
        return {
          exit,
          danglingTurns,
          danglingInvocations,
          exec,
          takeoverLease,
          takeoverAppend,
          lateAppend,
          entryCount,
          receipt,
          execAfter,
        };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W3");
    expect(r.danglingTurns).toBe(1);
    expect(r.danglingInvocations).toBe(1);
    expect(r.exec?.settled_at).toBeNull();
    expect(Number(r.takeoverLease.generation)).toBe(1);
    expect(r.takeoverAppend.sequence).toBe(0);
    expect((r.lateAppend as { _tag: string })._tag).toBe(
      "LeaseFencingRejected",
    );
    expect(r.entryCount).toBe(1);
    expect(
      (r.receipt as { resolution: { _tag: string } }).resolution._tag,
    ).toBe("Committed");
    expect(r.execAfter?.settlement_kind).toBe("Completed");
  });

  it("W4 [crash-injected]: kill after settlement proposal, before canonical COMMIT — nothing durable, retry converges, no partial state", async () => {
    expect(labeled("W4-pre-canonical-commit", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W4", providerTurnId, toolInvocationId(1)),
        );
        const commandsAfterCrash = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM commands",
        );
        const settledEvents = yield* eventsOf("ExecutionSettled");
        const workWaits = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM work_waits",
        );
        const exec = yield* executionState;
        const receipt = yield* settleViaGateway(0 as never, completed);
        const commandsAfterRetry = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM commands",
        );
        const settledEventsAfter = yield* eventsOf("ExecutionSettled");
        const execAfter = yield* executionState;
        return {
          exit,
          commandsAfterCrash,
          settledEvents,
          workWaits,
          exec,
          receipt,
          commandsAfterRetry,
          settledEventsAfter,
          execAfter,
        };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W4");
    expect(r.commandsAfterCrash).toBe(0);
    expect(r.settledEvents).toBe(0);
    expect(r.workWaits).toBe(0);
    expect(r.exec?.settled_at).toBeNull();
    expect(
      (r.receipt as { resolution: { _tag: string } }).resolution._tag,
    ).toBe("Committed");
    expect(r.commandsAfterRetry).toBe(1);
    expect(r.settledEventsAfter).toBe(1);
    expect(r.execAfter?.settlement_kind).toBe("Completed");
  });

  it("W5 [crash-injected]: kill after effectful work before SettleExecution — stays Active, unresolved side effects gate recovery settlement", async () => {
    expect(
      labeled("W5-pre-settle-effect-dangling", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W5", providerTurnId, toolInvocationId(1)),
        );
        const exec = yield* executionState;
        const tx = yield* TransactionPort;
        const repo = yield* ExecutionRepository;
        const now = yield* clockNow;
        yield* tx.transact(repo.requestStop(executionId, now));
        const recovery = yield* runRecovery(principal);
        const execAfter = yield* executionState;
        const escalations = yield* eventsOf("ReconciliationEscalated");
        return { exit, exec, recovery, execAfter, escalations };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W5");
    expect(r.exec?.settled_at).toBeNull();
    expect(r.recovery.settled).toEqual([]);
    expect(r.recovery.escalated).toEqual([executionId]);
    expect(r.execAfter?.settled_at).toBeNull();
    expect(r.execAfter?.settlement_kind).not.toBe("Interrupted");
    expect(r.escalations).toBeGreaterThanOrEqual(1);
  });
});

describe("p9-resurrection (R1–R6, 02 §2)", () => {
  it("R1 [crash-injected]: stale-generation Execution mutation (settle) — FencingRejected, zero durable Execution change", async () => {
    expect(labeled("R1-execution-mutation", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const generations = yield* takeover;
        const receipt = yield* settleViaGateway(generations.old, completed);
        const exec = yield* executionState;
        const settledEvents = yield* eventsOf("ExecutionSettled");
        const work = yield* workOpen;
        return { generations, receipt, exec, settledEvents, work };
      }),
    );
    expect(Number(r.generations.current)).toBe(1);
    const resolution = (
      r.receipt as { resolution: { _tag: string; error?: { _tag: string } } }
    ).resolution;
    expect(resolution._tag).toBe("TerminalRejected");
    expect(resolution.error?._tag).toBe("FencingRejected");
    expect(r.exec?.settled_at).toBeNull();
    expect(r.settledEvents).toBe(0);
    expect(r.work).toBe(1);
  });

  it("R2 [crash-injected]: stale-generation Session append — LeaseFencingRejected, no entry visible", async () => {
    expect(labeled("R2-session-append", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const generations = yield* takeover;
        const tx = yield* TransactionPort;
        const sessions = yield* SessionRepository;
        const late = yield* tx
          .transact(
            sessions.appendEntry(
              sessionId,
              { entryKind: "ModelOutput", payload: { text: "stale" } },
              { executionId, fencingGeneration: generations.old },
            ),
          )
          .pipe(Effect.flip);
        const entryCount = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
          [sessionId],
        );
        const work = yield* workOpen;
        return { generations, late, entryCount, work };
      }),
    );
    expect((r.late as { _tag: string })._tag).toBe("LeaseFencingRejected");
    expect((r.late as { generation: number }).generation).toBe(
      Number(r.generations.old),
    );
    expect(r.entryCount).toBe(0);
    expect(r.work).toBe(1);
  });

  it("R3 [crash-injected]: stale-generation ProviderTurn settlement — LeaseFencingRejected, turn remains unsettled", async () => {
    expect(
      labeled("R3-provider-turn-settlement", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const first = yield* acquireLease("worker:a");
        yield* openProviderTurn(providerTurnId);
        yield* expireInPlace("worker:a", first.generation);
        const next = yield* acquireLease("worker:b");
        const tx = yield* TransactionPort;
        const turns = yield* ProviderTurnStore;
        const late = yield* tx
          .transact(
            withLeaseFence(
              first.generation,
              turns.settleTurn(providerTurnId, "Stop", "{}", "t"),
            ),
          )
          .pipe(Effect.flip);
        const unsettledTurns = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM provider_turns WHERE provider_turn_id = ? AND settled_at IS NULL",
          [providerTurnId],
        );
        const work = yield* workOpen;
        return { first, next, late, unsettledTurns, work };
      }),
    );
    expect(Number(r.first.generation)).toBe(0);
    expect(Number(r.next.generation)).toBe(1);
    expect((r.late as { _tag: string })._tag).toBe("LeaseFencingRejected");
    expect(r.unsettledTurns).toBe(1);
    expect(r.work).toBe(1);
  });

  it("R4 [crash-injected]: stale-generation ToolInvocation settlement — LeaseFencingRejected, invocation remains unsettled", async () => {
    expect(
      labeled("R4-tool-invocation-settlement", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const invocationId = toolInvocationId(1);
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const first = yield* acquireLease("worker:a");
        yield* recordToolIntent(invocationId);
        yield* expireInPlace("worker:a", first.generation);
        const next = yield* acquireLease("worker:b");
        const tx = yield* TransactionPort;
        const tools = yield* ToolInvocationStore;
        const late = yield* tx
          .transact(
            withLeaseFence(
              first.generation,
              tools.settle(invocationId, { _tag: "Success" }, null, "t"),
            ),
          )
          .pipe(Effect.flip);
        const unsettled = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ? AND settled_at IS NULL",
          [invocationId],
        );
        const work = yield* workOpen;
        return { first, next, late, unsettled, work };
      }),
    );
    expect(Number(r.next.generation)).toBe(1);
    expect((r.late as { _tag: string })._tag).toBe("LeaseFencingRejected");
    expect(r.unsettled).toBe(1);
    expect(r.work).toBe(1);
  });

  it("R5 [crash-injected]: stale-generation canonical command (SelectCurrentWork) — terminal FencingRejected, no ordinary retry, Work lifecycle unchanged", async () => {
    expect(labeled("R5-canonical-command", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const generations = yield* takeover;
        const staleCommandId = nextCommandId();
        const stale = yield* selectCurrentWorkViaGateway(
          staleCommandId,
          generations.old,
        );
        const retry = yield* selectCurrentWorkViaGateway(
          staleCommandId,
          generations.old,
        );
        const live = yield* selectCurrentWorkViaGateway(
          nextCommandId(),
          generations.current,
        );
        const work = yield* workOpen;
        const currentWorkChanged = yield* eventsOf("CurrentWorkChanged");
        const currentWorkId = yield* Effect.gen(function* () {
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{ current_work_id: string | null }>(
            "SELECT current_work_id FROM workspaces WHERE workspace_id = ?",
            [workspaceId],
          );
          return rows[0]?.current_work_id ?? null;
        });
        return {
          generations,
          stale,
          retry,
          live,
          work,
          currentWorkChanged,
          currentWorkId,
        };
      }),
    );
    const staleResolution = (
      r.stale as { resolution: { _tag: string; error?: { _tag: string } } }
    ).resolution;
    expect(staleResolution._tag).toBe("TerminalRejected");
    expect(staleResolution.error?._tag).toBe("FencingRejected");
    const retryResolution = (
      r.retry as { resolution: { _tag: string; error?: { _tag: string } } }
    ).resolution;
    expect(retryResolution._tag).toBe("TerminalRejected");
    expect(retryResolution.error?._tag).toBe("FencingRejected");
    expect((r.live as { resolution: { _tag: string } }).resolution._tag).toBe(
      "Committed",
    );
    expect(r.work).toBe(1);
    expect(r.currentWorkChanged).toBe(1);
    expect(r.currentWorkId).toBe(workId);
  });

  it("R6 [crash-injected]: resurrected worker's uncommitted local writes are invisible — nothing crossed a commit boundary", async () => {
    expect(labeled("R6-uncommitted-writes", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const invocationId = toolInvocationId(9);
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const generations = yield* takeover;
        const tx = yield* TransactionPort;
        const exit = yield* Effect.exit(
          tx.transact(
            Effect.gen(function* () {
              const sessions = yield* SessionRepository;
              yield* sessions.appendEntry(sessionId, {
                entryKind: "Observation",
                payload: { late: true },
              });
              yield* recordToolIntent(invocationId);
              yield* Effect.die(new Error("harness-kill:R6-pre-commit"));
            }),
          ),
        );
        const entryCount = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
          [sessionId],
        );
        const invocationCount = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
          [invocationId],
        );
        const exec = yield* executionState;
        const work = yield* workOpen;
        return { generations, exit, entryCount, invocationCount, exec, work };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(Number(r.generations.current)).toBe(1);
    expect(r.entryCount).toBe(0);
    expect(r.invocationCount).toBe(0);
    expect(r.exec?.settled_at).toBeNull();
    expect(r.work).toBe(1);
  });
});
