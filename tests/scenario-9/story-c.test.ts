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
  ProviderTurnStoreLive,
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
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  makeSelectCurrentWorkHandler,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
  type VerifiedRuntimeCommandAuthority,
} from "../../packages/application/src/index.js";
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
} from "../../packages/domain/dist/index.js";
import {
  FenceStopCheckLive,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  makeP2CommandHandlers,
  preDispatchCheck,
  type SettleExecutionPayload,
} from "../../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionRepository,
  LeaseService,
  ProjectRepository,
  ProviderTurnStore,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import { NoHoldWorkReadmissionGateStoreService } from "../../packages/testkit/src/index.js";
import { yieldedSettlement } from "../support/execution-episode-fixtures.js";
import { labeled } from "../support/harness-api.js";
import { durableFile, executionRowOf, runOn, sqlCount } from "./support.js";

// ---------------------------------------------------------------------------
// Story C wiring: the p9-worker-crash resurrection app (P2 +
// SelectCurrentWork handlers, provider/tool stores, lease + fence
// services).
// ---------------------------------------------------------------------------

const C_PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c3");
const C_WORKSPACE = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c3",
);
const C_WORK = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c3");
const C_SESSION = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789c3");
const C_EXECUTION = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789c3",
) as ExecutionId;
const C_EXECUTION_T4 = "exe_018f2b3c-4d5e-7abc-8def-0123456789c4";
const C_TURN = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789c3",
);
const C_INVOCATION = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789c3",
);
const C_ACTOR = parse(Actor)("user:story-c");
const C_PRINCIPAL = parse(Principal)("runtime:system");

let cCommandSeq = 0;
const nextCCommandId = () => {
  cCommandSeq += 1;
  return parse(CommandId)(
    `cmd_018f2b3c-4d5e-7abc-8def-0123456789${String(cCommandSeq).padStart(2, "0")}`,
  );
};

const makeStoryCApp = (filename: string) => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const execRepo = Layer.provide(ExecutionRepositoryLive, infra);
  const repositories = Layer.mergeAll(
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    execRepo,
  );
  const registry = Layer.provide(
    Layer.effect(
      CommandHandlerRegistry,
      Effect.gen(function* () {
        const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
          ...makeP2CommandHandlers({
            projects: yield* ProjectRepository,
            workspaces: yield* WorkspaceRepository,
            sessions: yield* SessionRepository,
            executions: yield* ExecutionRepository,
            readmissionGate: NoHoldWorkReadmissionGateStoreService,
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
    ),
    repositories,
  );
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(ProviderTurnStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    execRepo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, execRepo)),
    Layer.provide(FenceStopCheckLive, Layer.merge(infra, execRepo)),
  );
  const all = Layer.mergeAll(infra, stores, registry);
  return Layer.mergeAll(all, Layer.provide(CommandGatewayLive, all));
};

const seedStoryC = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          C_PROJECT,
          "p9-accept-c",
          C_WORKSPACE,
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
        [C_SESSION, C_EXECUTION],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'w','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [C_WORKSPACE, C_PROJECT, C_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Open',0,'t','t')",
        [
          C_WORK,
          C_PROJECT,
          C_WORKSPACE,
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
        [C_EXECUTION, C_PROJECT, C_WORKSPACE, C_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?, 'ExecutionScoped', NULL, ?, 0, 't')",
        [`ses_${C_EXECUTION_T4}`, C_EXECUTION_T4],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [C_EXECUTION_T4, C_PROJECT, C_WORKSPACE, `ses_${C_EXECUTION_T4}`],
      );
    }),
  );
});

const cAcquireLease = (workerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx.transact(leases.acquire(C_EXECUTION, workerId, "inc-a"));
  });

const cExpireInPlace = (workerId: string, generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repo = yield* ExecutionRepository;
    yield* tx.transact(
      repo.releaseLease(C_EXECUTION, workerId, "inc-a", generation),
    );
  });

const cRenewLease = (workerId: string, generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx.transact(
      leases.renew(C_EXECUTION, workerId, "inc-a", generation),
    );
  });

const cCompleted: SettleExecutionPayload["settlement"] = {
  ...yieldedSettlement,
};

const cSettleViaGateway = (
  generation: LeaseGeneration,
  settlement: SettleExecutionPayload["settlement"],
) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const commandId = nextCCommandId();
    const payload: SettleExecutionPayload = {
      executionId: C_EXECUTION,
      settlement,
      expectedFencingGeneration: generation,
    };
    return yield* gw.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: C_PROJECT,
        actor: C_ACTOR,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal: C_PRINCIPAL,
        executionId: C_EXECUTION,
        fencingGeneration: generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        principal: C_PRINCIPAL,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId: C_PROJECT,
          actor: C_ACTOR,
          schemaVersion: "1",
          payload,
        }),
        projectId: C_PROJECT,
        commandKind: "SettleExecution",
        executionId: C_EXECUTION,
        fencingGeneration: generation,
      } satisfies VerifiedRuntimeCommandAuthority,
    );
  });

const cSelectCurrentWork = (
  commandId: CommandId,
  generation: LeaseGeneration,
) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const payload = {
      workspaceId: C_WORKSPACE,
      workId: C_WORK,
      expectedWorkspaceRevision: parse(Revision)(0),
    };
    return yield* gw.execute(
      {
        commandType: "SelectCurrentWork",
        commandId,
        projectId: C_PROJECT,
        actor: C_ACTOR,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal: C_PRINCIPAL,
        executionId: C_EXECUTION,
        fencingGeneration: generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SelectCurrentWorkAuthority",
        principal: C_PRINCIPAL,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SelectCurrentWork",
          projectId: C_PROJECT,
          actor: C_ACTOR,
          schemaVersion: "1",
          payload,
        }),
        projectId: C_PROJECT,
        targetWorkspaceId: C_WORKSPACE,
      } satisfies VerifiedCommandAuthority,
    );
  });

/** P2 `03` §3 fence predicate composed with the write in ONE transaction
 * (p9-worker-crash withLeaseFence precedent). */
const cLeaseFenceHolds = (generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const now = yield* clock.now();
    const rows = yield* sql
      .unsafe<{ ok: number }>(
        "SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL",
        [C_EXECUTION, generation, now],
      )
      .pipe(Effect.orDie);
    return rows.length > 0;
  });

const cWithLeaseFence = <A, E, R>(
  generation: LeaseGeneration,
  write: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const holds = yield* cLeaseFenceHolds(generation);
    if (!holds) {
      return yield* Effect.fail({
        _tag: "LeaseFencingRejected" as const,
        executionId: C_EXECUTION,
        generation,
      });
    }
    return yield* write;
  });

const cOpenProviderTurn = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const turns = yield* ProviderTurnStore;
  yield* tx.transact(
    turns.startTurn(
      {
        providerTurnId: C_TURN,
        executionId: C_EXECUTION,
        sessionId: C_SESSION,
        contextEpoch: 0 as never,
        modelRef: "provider-fake",
        outputContractRef: "oc",
        manifestId: "mf_story_c",
      },
      "t",
    ),
  );
});

const cToolFence = (workerId: string, generation: LeaseGeneration) => ({
  executionId: C_EXECUTION,
  workerId,
  workerIncarnationId: "inc-a",
  fencingGeneration: generation,
});

const cRecordToolIntent = (executionFence: ReturnType<typeof cToolFence>) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const tools = yield* ToolInvocationStore;
    const clock = yield* Clock;
    const now = yield* clock.now();
    yield* tx.transact(
      tools.recordIntent(
        {
          invocationId: C_INVOCATION,
          executionId: C_EXECUTION,
          workspaceId: C_WORKSPACE,
          toolName: "shell",
          toolVersion: "1",
          sideEffectSemantics: "NonIdempotent",
          argumentsJson: "{}",
          resolvedRegions: [],
          approvalId: null,
          intentAt: now,
        },
        executionFence,
        now,
      ),
    );
  });

const cSideEffectCounters = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const events = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events",
  );
  const commands = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM commands",
  );
  const settled = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM executions WHERE settled_at IS NOT NULL",
  );
  const workWaits = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM work_waits",
  );
  const timers = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM scheduler_timers",
  );
  const sessionEntries = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM session_entries",
  );
  return {
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    events: Number(events[0]!.count),
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    commands: Number(commands[0]!.count),
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    settled: Number(settled[0]!.count),
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    workWaits: Number(workWaits[0]!.count),
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    timers: Number(timers[0]!.count),
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    sessionEntries: Number(sessionEntries[0]!.count),
  };
});

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe("-acceptance", () => {
  it("Story C (06 §C) [crash-injected]: resurrection and expiry — five stale write surfaces all rejected, renewal boundary (TTL/3) commits then rejects, pre-dispatch T4 runs zero nine-step side effects", async () => {
    expect(
      labeled("story-C-resurrection-and-expiry", "crash-injected").guarantee,
    ).toBe("crash-injected");
    expect(LEASE_RENEW_INTERVAL_MS).toBe(LEASE_TTL_MS / 3);
    await runOn(
      Effect.gen(function* () {
        // Retain the historical P12 fixture schema, then apply current P4
        // P36 storage before running the current ToolInvocation store.
        yield* runMigrations(P12_MIGRATIONS);
        yield* runMigrations(P36_MIGRATIONS);
        yield* seedStoryC;
        // Takeover fixture: the old worker (g) resurrects across g+1.
        const old = yield* cAcquireLease("worker:a");
        yield* cExpireInPlace("worker:a", old.generation);
        const current = yield* cAcquireLease("worker:b");
        expect(Number(current.generation)).toBe(Number(old.generation) + 1);
        // Surface 1: stale Execution settle.
        const r1 = yield* cSettleViaGateway(old.generation, cCompleted);
        const r1Resolution = (
          r1 as { resolution: { _tag: string; error?: { _tag: string } } }
        ).resolution;
        expect(r1Resolution._tag).toBe("TerminalRejected");
        expect(r1Resolution.error?._tag).toBe("FencingRejected");
        // Surface 2: stale Session append.
        const tx = yield* TransactionPort;
        const sessions = yield* SessionRepository;
        const r2 = yield* tx
          .transact(
            sessions.appendEntry(
              C_SESSION,
              { entryKind: "ModelOutput", payload: { text: "stale" } },
              { executionId: C_EXECUTION, fencingGeneration: old.generation },
            ),
          )
          .pipe(Effect.flip);
        expect((r2 as { _tag: string })._tag).toBe("LeaseFencingRejected");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
            [C_SESSION],
          ),
        ).toBe(0);
        // Surface 3: stale ProviderTurn settlement (fence shares the tx).
        yield* cOpenProviderTurn;
        const turns = yield* ProviderTurnStore;
        const r3 = yield* tx
          .transact(
            cWithLeaseFence(
              old.generation,
              turns.settleTurn(C_TURN, "Stop", "{}", "t"),
            ),
          )
          .pipe(Effect.flip);
        expect((r3 as { _tag: string })._tag).toBe("LeaseFencingRejected");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM provider_turns WHERE provider_turn_id = ? AND settled_at IS NULL",
            [C_TURN],
          ),
        ).toBe(1);
        // Surface 4: stale ToolInvocation settlement.
        yield* cRecordToolIntent(cToolFence("worker:b", current.generation));
        const tools = yield* ToolInvocationStore;
        const r4 = yield* tx
          .transact(
            cWithLeaseFence(
              old.generation,
              tools.settle(
                C_INVOCATION,
                { _tag: "Success" },
                null,
                "t",
                cToolFence("worker:a", old.generation),
                "t",
              ),
            ),
          )
          .pipe(Effect.flip);
        expect((r4 as { _tag: string })._tag).toBe("LeaseFencingRejected");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ? AND settled_at IS NULL",
            [C_INVOCATION],
          ),
        ).toBe(1);
        // Surface 5: stale agent-produced canonical command.
        const staleCommandId = nextCCommandId();
        const r5 = yield* cSelectCurrentWork(staleCommandId, old.generation);
        const r5Retry = yield* cSelectCurrentWork(
          staleCommandId,
          old.generation,
        );
        const r5Live = yield* cSelectCurrentWork(
          nextCCommandId(),
          current.generation,
        );
        const staleResolution = (
          r5 as { resolution: { _tag: string; error?: { _tag: string } } }
        ).resolution;
        expect(staleResolution._tag).toBe("TerminalRejected");
        expect(staleResolution.error?._tag).toBe("FencingRejected");
        expect(
          (r5Retry as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("TerminalRejected");
        expect(
          (r5Live as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("Committed");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM works WHERE work_id = ? AND lifecycle = 'Open'",
            [C_WORK],
          ),
        ).toBe(1);
        // Renewal boundary: while live the CAS commits and the fenced
        // write lands; after expiry both reject.
        yield* Effect.sleep(2);
        const renewed = yield* cRenewLease("worker:b", current.generation);
        expect(Number(renewed.generation)).toBe(Number(current.generation));
        expect(renewed.expiresAt > current.expiresAt).toBe(true);
        const ownerAppend = yield* tx.transact(
          sessions.appendEntry(
            C_SESSION,
            { entryKind: "ModelOutput", payload: { text: "owner" } },
            {
              executionId: C_EXECUTION,
              fencingGeneration: current.generation,
            },
          ),
        );
        expect(ownerAppend.sequence).toBe(0);
        yield* cExpireInPlace("worker:b", current.generation);
        // L1 face: post-expiry settle rejected — the fence predicate's
        // `expires_at > now` clause fails for the released lease.
        const lateSettle = yield* cSettleViaGateway(
          current.generation,
          cCompleted,
        );
        const lateSettleResolution = (
          lateSettle as {
            resolution: { _tag: string; error?: { _tag: string } };
          }
        ).resolution;
        expect(lateSettleResolution._tag).toBe("TerminalRejected");
        expect(lateSettleResolution.error?._tag).toBe("FencingRejected");
        const lateExec = yield* executionRowOf(C_EXECUTION);
        expect(lateExec?.settled_at).toBeNull();
        // T4: the targeted pre-dispatch check is the fence predicate read
        // only — zero nine-step observables (side-effect count = 0).
        const live = yield* cAcquireLease("worker:c");
        expect(Number(live.generation)).toBe(Number(current.generation) + 1);
        const before = yield* cSideEffectCounters;
        expect(yield* preDispatchCheck(C_EXECUTION)).toBe(false);
        yield* cExpireInPlace("worker:c", live.generation);
        expect(yield* preDispatchCheck(C_EXECUTION)).toBe(true);
        expect(yield* preDispatchCheck(C_EXECUTION_T4 as never)).toBe(true);
        expect(yield* cSideEffectCounters).toEqual(before);
        // L3 face: stale-worker renewal and stale fenced write rejected
        // after the takeover-by-expiry window.
        const lateRenew = yield* cRenewLease(
          "worker:b",
          current.generation,
        ).pipe(Effect.flip);
        expect((lateRenew as { _tag: string })._tag).toBe(
          "LeaseFencingRejected",
        );
        const lateAppend = yield* tx
          .transact(
            sessions.appendEntry(
              C_SESSION,
              { entryKind: "ModelOutput", payload: { text: "late" } },
              {
                executionId: C_EXECUTION,
                fencingGeneration: current.generation,
              },
            ),
          )
          .pipe(Effect.flip);
        expect((lateAppend as { _tag: string })._tag).toBe(
          "LeaseFencingRejected",
        );
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
            [C_SESSION],
          ),
        ).toBe(1);
      }),
      makeStoryCApp(durableFile("c")),
    );
  });
});
