import {
  Actor,
  ExecutionId,
  type LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  type ToolDefinition,
  ToolDefinitionStore,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  type TransactionPortService,
  type TransactionScope,
} from "@arbor/ports";
import { Context, Effect, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  type ToolExecutor,
  ToolRuntimeLive,
} from "../../../packages/tool-runtime/src/index.js";
import {
  layer,
  P12_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const principal = parse(Principal)("worker:p4-expiry");
const actor = parse(Actor)("worker:p4-expiry");
const beforeExpiry = "2026-10-10T00:00:09.000Z";
const leaseExpiry = "2026-10-10T00:00:10.000Z";
const afterExpiry = "2026-10-10T00:00:11.000Z";

class BaseTransactionPort extends Context.Service<
  BaseTransactionPort,
  TransactionPortService
>()("test/P4FenceExpiryBaseTransactionPort") {}

interface FenceExpiryControl {
  now: string;
  observeNextTransaction: boolean;
  onQueued?: () => void;
}

const definition: ToolDefinition = {
  name: "write_once",
  version: "1",
  hash: "write-once-expiry-v1",
  description: "Perform one non-idempotent effect.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "NonIdempotent",
  source: "Builtin",
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p4-fence-expiry",
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
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
        [
          executionId,
          projectId,
          "workspace",
          workspaceId,
          "coordination",
          sessionId,
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?,?)",
        [
          executionId,
          "worker:local",
          "wic_local_process",
          0,
          leaseExpiry,
          beforeExpiry,
        ],
      );
    }),
  );
});

const intent = {
  callRef: "call-p4-fence-expiry",
  toolName: definition.name,
  toolVersion: definition.version,
  argumentsJson: "{}",
  invocationId,
  approvalId: null,
} as const;

const context = {
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
    toolName: intent.toolName,
    toolVersion: intent.toolVersion,
    resourceSpaceIds: [],
    allowedCapabilities: [],
    controlBasisDigest: "p4-fence-expiry-basis",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "p4-fence-expiry-basis",
  executionFence: {
    executionId,
    workerId: "worker:local",
    workerIncarnationId: "wic_local_process",
    fencingGeneration: 0 as LeaseGeneration,
  },
  requestedAt: beforeExpiry,
} as const;

describe("P4 settlement fence expiry time", () => {
  it("samples fence time after a queued BEGIN IMMEDIATE, not with the earlier settlement timestamp", async () => {
    const sqlite = layer({ filename: ":memory:" });
    const control: FenceExpiryControl = {
      now: beforeExpiry,
      observeNextTransaction: false,
    };
    let resolveSettlementTimestampSampled: (() => void) | undefined;
    const settlementTimestampSampled = new Promise<void>((resolve) => {
      resolveSettlementTimestampSampled = resolve;
    });
    let releaseSettlementProbe: (() => void) | undefined;
    const settlementProbeGate = new Promise<void>((resolve) => {
      releaseSettlementProbe = resolve;
    });
    let resolveHolderEntered: (() => void) | undefined;
    const holderEntered = new Promise<void>((resolve) => {
      resolveHolderEntered = resolve;
    });
    let releaseHolder: (() => void) | undefined;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let resolveSettlementQueued: (() => void) | undefined;
    const settlementQueued = new Promise<void>((resolve) => {
      resolveSettlementQueued = resolve;
    });
    let externalEffects = 0;
    let settlementCommittedProbe = false;

    const baseTransactions = Layer.provide(TransactionPortLive, sqlite);
    const baseTransactionAlias = Layer.effect(
      BaseTransactionPort,
      Effect.map(TransactionPort, (service) => service),
    ).pipe(Layer.provide(baseTransactions));
    const gatedTransactions = Layer.effect(
      TransactionPort,
      Effect.gen(function* () {
        const base = yield* BaseTransactionPort;
        const transact: TransactionPortService["transact"] = <A, E, R>(
          body: Effect.Effect<A, E, R | TransactionScope>,
        ) => {
          if (control.observeNextTransaction) {
            control.observeNextTransaction = false;
            resolveSettlementQueued?.();
          }
          return base.transact(body);
        };
        return TransactionPort.of({ transact });
      }),
    ).pipe(Layer.provide(baseTransactionAlias));
    const executor: ToolExecutor = {
      name: definition.name,
      write: true,
      requiresApproval: () => false,
      execute: () =>
        Effect.sync(() => {
          externalEffects += 1;
          return {
            settlement: { _tag: "Success" as const },
            observation: { text: "effect completed", truncated: false },
            resultRef: null,
          };
        }),
    };
    const qualificationProbe = async (event: { readonly boundary: string }) => {
      if (event.boundary === "AH7BeforeToolSettlementTransaction") {
        resolveSettlementTimestampSampled?.();
        await settlementProbeGate;
      }
      if (event.boundary === "AH7AfterToolSettlementCommit") {
        settlementCommittedProbe = true;
      }
    };
    const dependencies = Layer.mergeAll(
      sqlite,
      baseTransactionAlias,
      gatedTransactions,
      Layer.provide(ToolInvocationStoreLive, sqlite),
      Layer.succeed(Clock, {
        now: () => Effect.succeed(control.now),
      }),
      Layer.succeed(ToolDefinitionStore, {
        definition: () => Effect.succeed(Option.some(definition)),
        all: () => Effect.succeed([definition]),
      }),
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: "p4-expiry-sandbox",
            rootPath: "/repo",
            writableRegions: [],
          }),
        close: () => Effect.void,
      }),
      Layer.succeed(ResourceAdmission, {
        admit: () => Effect.succeed({ _tag: "Admitted" as const }),
      }),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: () =>
          Effect.succeed({
            regions: [],
            observedEnvironmentRevision: "p4-expiry-env",
          }),
      }),
    );
    const app = Layer.mergeAll(
      dependencies,
      Layer.provide(
        ToolRuntimeLive([executor], { qualificationProbe }),
        dependencies,
      ),
    );

    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      const runtime = yield* ToolRuntimePort;
      const base = yield* BaseTransactionPort;
      const tx = yield* TransactionPort;
      const store = yield* ToolInvocationStore;
      const invocation = yield* Effect.forkChild(
        Effect.match(runtime.invoke(intent, context), {
          onFailure: (error) => ({ _tag: "Rejected" as const, error }),
          onSuccess: (value) => ({ _tag: "Observed" as const, value }),
        }),
      );
      yield* Effect.promise(() => settlementTimestampSampled);

      const lock = yield* Effect.forkChild(
        base.transact(
          Effect.promise(() => {
            resolveHolderEntered?.();
            return holderGate;
          }),
        ),
      );
      yield* Effect.promise(() => holderEntered);
      control.observeNextTransaction = true;
      releaseSettlementProbe?.();
      yield* Effect.promise(() => settlementQueued);

      // The execution lease still has generation 0. Only injected Clock time
      // advances past expires_at while the settlement is queued for BEGIN.
      control.now = afterExpiry;
      releaseHolder?.();
      yield* Fiber.join(lock);
      const outcome = yield* Fiber.join(invocation);
      const canonical = yield* tx.transact(store.findById(invocationId));
      return { outcome, canonical };
    });
    const result = (await Effect.runPromise(
      Effect.scoped(Effect.provide(program, app)) as Effect.Effect<
        unknown,
        unknown,
        never
      >,
    )) as {
      readonly outcome:
        | { readonly _tag: "Rejected"; readonly error: unknown }
        | {
            readonly _tag: "Observed";
            readonly value: { readonly _tag: string };
          };
      readonly canonical: Option.Option<{
        readonly settledAt: string | null;
        readonly settlement: { readonly _tag: string } | null;
      }>;
    };

    expect.soft(result.outcome._tag).toBe("Rejected");
    if (result.outcome._tag === "Rejected") {
      expect.soft(result.outcome.error).toMatchObject({
        _tag: "LeaseFencingRejected",
        executionId,
        generation: 0,
      });
    }
    expect.soft(externalEffects).toBe(1);
    expect.soft(settlementCommittedProbe).toBe(false);
    expect.soft(Option.isSome(result.canonical)).toBe(true);
    if (Option.isSome(result.canonical)) {
      expect.soft(result.canonical.value.settledAt).toBeNull();
      expect.soft(result.canonical.value.settlement).toBeNull();
    }
  });
});
