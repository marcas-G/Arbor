import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AgentExecutionStateStoreLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P12_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "../packages/application/src/index.js";
import type { SandboxPolicyDecision } from "../packages/domain/dist/index.js";
import {
  Actor,
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  type AdmitExecutionPayload,
  FenceStopCheckLive,
  P2CommandHandlerRegistryLive,
  RuntimeSafetyGateLive,
  runExecution,
} from "../packages/execution-runtime/src/index.js";
import {
  AgentLoopStepStore,
  type ControlApprovalRecord,
  ControlApprovalStore,
  type ExecutableApprovalRecord,
  ExecutableApprovalStore,
  type ExecutionDriveOutcome,
  ExecutionDriverPort,
  RuntimeSafetyGate,
  SandboxPolicyDecisionStore,
  type SandboxProviderUnavailableFactV1,
  SandboxProviderUnavailableStore,
  WorkerDispatchPort,
} from "../packages/ports/src/index.js";
import { NoHoldWorkReadmissionGateStoreLive } from "../packages/testkit/src/index.js";
import {
  seedCurrentOpenWork,
  workEpisode,
  yieldedSettlement,
} from "./support/execution-episode-fixtures.js";
import { makeP41OptionalTestServices } from "./support/p41-optional-test-services.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("worker:a");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");

const makeApp = (
  settlement: ExecutionDriveOutcome,
  options: {
    readonly pendingApproval?: ExecutableApprovalRecord;
    readonly pendingControlApproval?: ControlApprovalRecord;
    readonly calls?: { dispatch: number; drive: number };
    readonly omitExecutableApprovalStore?: boolean;
    readonly omitControlApprovalStore?: boolean;
  } = {},
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const p41OptionalServices = makeP41OptionalTestServices(
    Layer.merge(infra, journal),
  );
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));
  const repos = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    NoHoldWorkReadmissionGateStoreLive,
    Layer.provide(CommandStoreLive, infra),
    journal,
    p41OptionalServices,
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
    repo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, repo)),
  );
  const calls = options.calls ?? { dispatch: 0, drive: 0 };
  const approvals = Layer.succeed(ExecutableApprovalStore, {
    findPendingForExecution: () =>
      Effect.succeed(
        options.pendingApproval === undefined
          ? Option.none()
          : Option.some(options.pendingApproval),
      ),
  } as never);
  const controlApprovals = Layer.succeed(ControlApprovalStore, {
    findPendingForExecution: () =>
      Effect.succeed(
        options.pendingControlApproval === undefined
          ? Option.none()
          : Option.some(options.pendingControlApproval),
      ),
  } as never);
  const core = Layer.mergeAll(
    infra,
    repos,
    fence,
    Layer.succeed(WorkerDispatchPort, {
      dispatch: () => {
        calls.dispatch += 1;
        return Effect.succeed({ dispatchId: "dispatch", acceptedAt: "t" });
      },
    }),
    Layer.succeed(ExecutionDriverPort, {
      drive: () => {
        calls.drive += 1;
        return Effect.succeed(settlement);
      },
    }),
    RuntimeSafetyGateLive(),
    Layer.provide(P2CommandHandlerRegistryLive, repos),
  );
  const withControlApprovals = options.omitControlApprovalStore
    ? core
    : Layer.merge(core, controlApprovals);
  const all = options.omitExecutableApprovalStore
    ? withControlApprovals
    : Layer.merge(withControlApprovals, approvals);
  return {
    layer: Layer.mergeAll(all, Layer.provide(CommandGatewayLive, all)),
    calls,
  };
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
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
      yield* seedCurrentOpenWork(projectId, workspaceId, workId);
    }),
  );
});

const admitPayload: AdmitExecutionPayload = {
  _tag: "WorkspaceMain",
  executionId,
  workspaceId,
  episode: workEpisode(workId),
};

const admit = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const commandId = parse(CommandId)(
    "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
  );
  const authority: VerifiedRuntimeCommandAuthority = {
    _tag: "AdmitExecutionAuthority",
    submissionOrigin: "System",
    principal,
    commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "AdmitExecution",
      projectId,
      actor,
      schemaVersion: "1",
      payload: admitPayload,
    }),
    projectId,
    commandKind: "AdmitExecution",
    workspaceId,
    bindingKind: "WorkspaceMain",
  };
  const envelope: GatewayEnvelope<AdmitExecutionPayload> = {
    commandType: "AdmitExecution",
    commandId,
    projectId,
    actor,
    issuedAt: "t",
    payload: admitPayload,
  };
  yield* gateway.execute(
    envelope,
    { _tag: "System", principal, causationRef: "c" },
    authority,
  );
});

const run = <A>(
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  program: Effect.Effect<A, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
    Effect.provide(program, app) as Effect.Effect<A, any, never>,
  );

describe("P2-014 driver / dispatch / safety", () => {
  it("settles the driver's proposal through the command pipeline", async () => {
    const app = makeApp(yieldedSettlement);
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* admit;
      const settlement = yield* runExecution(
        executionId,
        { _tag: "Recovery" },
        principal,
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{
        settlement_kind: string | null;
        settled_at: string | null;
      }>(
        "SELECT settlement_kind, settled_at FROM executions WHERE execution_id = ?",
        [executionId],
      );
      return {
        settlement,
        kind: rows[0]?.settlement_kind,
        settledAt: rows[0]?.settled_at,
      };
    });
    const r = await run(program, app.layer);
    expect((r as { settlement: { _tag: string } }).settlement._tag).toBe(
      "Completed",
    );
    expect((r as { kind: string | null }).kind).toBe("Completed");
    const settledAt = (r as { settledAt: string | null }).settledAt;
    expect(settledAt).not.toBe("t");
    expect(Number.isNaN(Date.parse(settledAt ?? ""))).toBe(false);
  });

  it("stops repeated action fingerprints at the safety gate", async () => {
    const app = makeApp(yieldedSettlement);
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      const gate = yield* RuntimeSafetyGate;
      const decisions: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        decisions.push(
          yield* gate.admitActivity(executionId, {
            _tag: "ToolInvocation",
            fingerprint: "fp",
          }),
        );
      }
      return decisions;
    });
    const decisions = await run(program, app.layer);
    expect(decisions).toEqual(["Continue", "Continue", "Continue", "Stop"]);
  });

  it("keeps a Pending executable approval paused before dispatch and lease acquisition", async () => {
    const calls = { dispatch: 0, drive: 0 };
    const app = makeApp(yieldedSettlement, {
      calls,
      pendingApproval: {
        approvalId: "eap_p2_pending_gate",
        routeKind: "Executable",
        executionId,
        logicalStepNo: 0,
        repairAttempt: 0,
        actionIndex: 0,
        logicalActionId: "lac_p2_pending_gate",
        projectId,
        workspaceId,
        subject: principal,
        callRef: "call_pending_gate",
        toolInvocationId: "tin_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
        toolName: "read",
        toolVersion: "1",
        sideEffectSemantics: "Idempotent",
        argumentsJson: "{}",
        actionDigest: "digest-pending-gate",
        targetResourceSpaceIds: [],
        controlBasisDigest: "basis-pending-gate",
        revision: 0,
        requestedAt: "2026-10-11T00:00:00.000Z",
        expiresAt: "2026-10-12T00:00:00.000Z",
        state: "Pending",
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        cancelledAt: null,
        cancelledBy: null,
        cancellationReason: null,
        consumedAt: null,
        consumedBy: null,
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* admit;
      const result = yield* runExecution(
        executionId,
        { _tag: "Recovery" },
        principal,
      );
      const sql = yield* SqlClient;
      const leases = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM execution_leases WHERE execution_id = ?",
        [executionId],
      );
      return { result, leases: leases[0]?.count ?? -1 };
    });
    const result = await run(program, app.layer);
    expect(result.result).toEqual({
      _tag: "ApprovalRequired",
      approvalId: "eap_p2_pending_gate",
      revision: 0,
    });
    expect(calls).toEqual({ dispatch: 0, drive: 0 });
    expect(result.leases).toBe(0);
  });

  it("keeps a Pending CAPA Control approval paused before dispatch and lease acquisition", async () => {
    const calls = { dispatch: 0, drive: 0 };
    const app = makeApp(yieldedSettlement, {
      calls,
      pendingControlApproval: {
        approvalId: "cap_p2_pending_gate",
        projectId,
        workspaceId,
        executionId,
        stableActionId: "select_current_work",
        actionDigest: "digest-control-pending-gate",
        argumentsJson: "{}",
        targetRef: "work:test",
        controlBasisDigest: "basis-control-pending-gate",
        state: "Pending",
        revision: 3,
        requestedAt: "2026-10-11T00:00:00.000Z",
        expiresAt: "2026-10-12T00:00:00.000Z",
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        consumedAt: null,
        bindingProven: true,
        consumedBy: null,
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* admit;
      const result = yield* runExecution(
        executionId,
        { _tag: "Recovery" },
        principal,
      );
      const sql = yield* SqlClient;
      const leases = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM execution_leases WHERE execution_id = ?",
        [executionId],
      );
      return { result, leases: leases[0]?.count ?? -1 };
    });
    const result = await run(program, app.layer);
    expect(result.result).toEqual({
      _tag: "ApprovalRequired",
      approvalId: "cap_p2_pending_gate",
      revision: 3,
    });
    expect(calls).toEqual({ dispatch: 0, drive: 0 });
    expect(result.leases).toBe(0);
  });

  it("fails closed before dispatch when the approval store is missing", async () => {
    const calls = { dispatch: 0, drive: 0 };
    const app = makeApp(yieldedSettlement, {
      calls,
      omitExecutableApprovalStore: true,
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* admit;
      const exit = yield* Effect.exit(
        runExecution(executionId, { _tag: "Recovery" }, principal),
      );
      const sql = yield* SqlClient;
      const leases = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM execution_leases WHERE execution_id = ?",
        [executionId],
      );
      return { exit, leases: leases[0]?.count ?? -1 };
    });
    const result = await run(program, app.layer);
    expect(result.exit._tag).toBe("Failure");
    expect(calls).toEqual({ dispatch: 0, drive: 0 });
    expect(result.leases).toBe(0);
  });

  it("fails closed before dispatch when the Control approval store is missing", async () => {
    const calls = { dispatch: 0, drive: 0 };
    const app = makeApp(yieldedSettlement, {
      calls,
      omitControlApprovalStore: true,
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* admit;
      const exit = yield* Effect.exit(
        runExecution(executionId, { _tag: "Recovery" }, principal),
      );
      const sql = yield* SqlClient;
      const leases = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM execution_leases WHERE execution_id = ?",
        [executionId],
      );
      return { exit, leases: leases[0]?.count ?? -1 };
    });
    const result = await run(program, app.layer);
    expect(result.exit._tag).toBe("Failure");
    expect(calls).toEqual({ dispatch: 0, drive: 0 });
    expect(result.leases).toBe(0);
  });

  it("persists typed provider unavailability and blocks exact-policy reprobe after restart", async () => {
    const calls = { dispatch: 0, drive: 0 };
    const policyDigest = "a".repeat(64);
    const outcome = {
      _tag: "SandboxProviderUnavailable" as const,
      outcome: {
        _tag: "SandboxProviderUnavailable" as const,
        projectId,
        workspaceId,
        executionId,
        episodeBinding: workEpisode(workId),
        policyRevision: 1,
        policyDigest,
        profileId: "ReadOnly" as const,
        providerId: "bwrap",
        providerVersion: "bwrap-v1",
        capabilityRevision: "cap-v1",
        probeEvidenceRef: "probe-ref",
        failureCode: "ProviderUnavailable",
        actionBinding: {
          identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
          providerTurnId: "ptn_p50_driver" as never,
          logicalActionId: "lac_p50_driver",
          actionIndex: 0,
          callRef: "call_p50_driver",
          invocationId: "tin_p50_driver" as never,
        },
      },
    } satisfies ExecutionDriveOutcome;
    const policy = {
      projectId,
      workspaceId,
      executionId,
      episodeBinding: workEpisode(workId),
      policyRevision: 1,
      expectedExecutionRevision: 0,
      expectedPolicyRevision: 0,
      profile: "ReadOnly",
      providerId: "bwrap",
      networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
      policyDigest,
      permissionGrantId: "pgr_p50_test",
      grantPermissionCommandId: "cmd_p50_test",
      grantIssuerPrincipal: "user:operator",
      operatorConfigRevision: 1,
      operatorConfigDigest: "b".repeat(64),
      actorPrincipal: "user:operator",
      decisionCommandId: "cmd_p50_decision",
      issuedAt: "2026-10-19T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as unknown as SandboxPolicyDecision;
    let persisted: SandboxProviderUnavailableFactV1 | undefined;
    const unavailableFacts = Layer.succeed(SandboxProviderUnavailableStore, {
      record: (
        input: import("../packages/ports/src/index.js").RecordSandboxProviderUnavailableInput,
      ) =>
        Effect.sync(() => {
          persisted = {
            attentionFactId: "att_p50_driver",
            eventId: "evt_p50_driver" as never,
            ...input.outcome,
            firstDetectedAt: input.firstDetectedAt,
          } as SandboxProviderUnavailableFactV1;
          return persisted;
        }),
      findByExecutionAndRevision: () => Effect.succeed(persisted),
      findByEventId: () => Effect.succeed(undefined),
      list: () => Effect.succeed(persisted === undefined ? [] : [persisted]),
    } as never);
    const sandboxDecisions = Layer.succeed(SandboxPolicyDecisionStore, {
      findExact: () => Effect.succeed(Option.some(policy)),
      findCurrentForExecution: () => Effect.succeed(Option.some(policy)),
      insertCommitted: () => Effect.void,
    } as never);
    const actionBinding =
      outcome._tag === "SandboxProviderUnavailable"
        ? outcome.outcome.actionBinding
        : undefined;
    const stepRecord =
      actionBinding === undefined
        ? undefined
        : {
            identity: actionBinding.identity,
            providerTurnId: actionBinding.providerTurnId,
            state: "ActionsInProgress" as const,
            nextActionIndex: actionBinding.actionIndex,
            revision: 1,
            updatedAt: "2026-10-19T00:00:00.000Z",
          };
    let persistedStep:
      | import("../packages/ports/src/index.js").AgentLoopStepRecord
      | undefined = stepRecord;
    const actionRecord =
      actionBinding === undefined
        ? undefined
        : {
            identity: actionBinding.identity,
            actionIndex: actionBinding.actionIndex,
            logicalActionId: actionBinding.logicalActionId,
            callRef: actionBinding.callRef,
            routeKind: "Executable" as const,
            actionKind: "shell",
            inputHash: "b".repeat(64),
            state: "Pending" as const,
            revision: 0,
            updatedAt: "2026-10-19T00:00:00.000Z",
          };
    let persistedAction:
      | import("../packages/ports/src/index.js").AgentLoopStepActionRecord
      | undefined = actionRecord;
    const loopStepStore = Layer.succeed(AgentLoopStepStore, {
      find: () =>
        Effect.succeed(
          persistedStep === undefined
            ? Option.none()
            : Option.some(persistedStep),
        ),
      listActions: () =>
        Effect.succeed(persistedAction === undefined ? [] : [persistedAction]),
      transitionAction: (input: {
        readonly next: import("../packages/ports/src/index.js").AgentLoopStepActionRecord;
      }) =>
        Effect.sync(() => {
          persistedAction = input.next;
          return input.next;
        }),
      transition: (input: {
        readonly next: import("../packages/ports/src/index.js").AgentLoopStepRecord;
      }) =>
        Effect.sync(() => {
          persistedStep = input.next;
          return input.next;
        }),
    } as never);
    const app = makeApp(outcome, { calls });
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* admit;
      const first = yield* runExecution(
        executionId,
        { _tag: "Recovery" },
        principal,
      );
      const second = yield* runExecution(
        executionId,
        { _tag: "Recovery" },
        principal,
      );
      const sql = yield* SqlClient;
      const executionRows = yield* sql.unsafe<{
        readonly settlement_kind: string | null;
        readonly settled_at: string | null;
      }>(
        `SELECT settlement_kind, settled_at FROM executions WHERE execution_id = ?`,
        [executionId],
      );
      return { first, second, execution: executionRows[0] };
    });
    const result = await run(
      program,
      Layer.mergeAll(
        app.layer,
        unavailableFacts,
        sandboxDecisions,
        loopStepStore,
      ),
    );
    expect(result.first._tag).toBe("RecoveryBlocked");
    expect(result.second._tag).toBe("RecoveryBlocked");
    expect(calls).toEqual({ dispatch: 1, drive: 1 });
    expect(persisted?.failureCode).toBe("ProviderUnavailable");
    expect(persistedAction).toMatchObject({
      state: "TerminalRejected",
      disposition: {
        _tag: "SandboxUnavailableV1",
        attentionFactId: persisted?.attentionFactId,
        invocationId: "tin_p50_driver",
      },
    });
    expect(persistedStep).toMatchObject({
      state: "StepEffectsCommitted",
      nextActionIndex: 1,
    });
    expect(result.execution).toEqual({
      settlement_kind: null,
      settled_at: null,
    });
  });
});
