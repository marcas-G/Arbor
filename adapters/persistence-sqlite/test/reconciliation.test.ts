import {
  ExecutionId,
  LeaseGeneration,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ReconciliationSource,
  ToolInvocationStore,
  TransactionPort,
} from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
import { ReconciliationSourceLive } from "../../../packages/tool-runtime/src/index.js";
import {
  layer,
  P36_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";
import { seedWorkspaceGraph } from "./support/seed-workspace.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionFence = {
  executionId,
  workerId: "worker:p4-reconciliation",
  workerIncarnationId: "incarnation:p4-reconciliation",
  fencingGeneration: parse(LeaseGeneration)(0),
};
const fenceNow = "2026-10-12T00:00:00.000Z";

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
  );
  return Layer.mergeAll(
    infra,
    deps,
    Layer.provide(ReconciliationSourceLive, deps),
  );
};

const seed = Effect.gen(function* () {
  yield* seedWorkspaceGraph({ projectId, workspaceId, sessionId });
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [executionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        "INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?,?)",
        [
          executionId,
          executionFence.workerId,
          executionFence.workerIncarnationId,
          0,
          "2999-01-01T00:00:00.000Z",
          "t",
        ],
      );
    }),
  );
});

const intent = (id: string, semantics: string) => ({
  invocationId: parse(ToolInvocationId)(id) as ToolInvocationId,
  executionId,
  workspaceId,
  toolName: "shell",
  toolVersion: "1",
  sideEffectSemantics: semantics as never,
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId: null,
  intentAt: "t",
});

describe("reconciliation source", () => {
  it.effect("reports only reconcilable unsettled invocations", () =>
    Effect.gen(function* () {
      const app = makeApp();
      const program = Effect.gen(function* () {
        yield* runMigrations(P36_MIGRATIONS);
        yield* seed;
        const tx = yield* TransactionPort;
        const store = yield* ToolInvocationStore;
        const source = yield* ReconciliationSource;
        yield* tx.transact(
          store.recordIntent(
            intent("tin_018f2b3c-4d5e-7abc-8def-0123456789a1", "Reconcilable"),
            executionFence,
            fenceNow,
          ),
        );
        yield* tx.transact(
          store.recordIntent(
            intent("tin_018f2b3c-4d5e-7abc-8def-0123456789a2", "ReadOnly"),
            executionFence,
            fenceNow,
          ),
        );
        yield* tx.transact(
          store.recordIntent(
            intent("tin_018f2b3c-4d5e-7abc-8def-0123456789a3", "NonIdempotent"),
            executionFence,
            fenceNow,
          ),
        );
        return yield* tx.transact(source.pending(executionId));
      });
      const pending = yield* Effect.provide(program, app) as Effect.Effect<
        ReadonlyArray<string>,
        unknown,
        never
      >;
      expect([...pending].sort()).toEqual([
        "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
        "tin_018f2b3c-4d5e-7abc-8def-0123456789a3",
      ]);
    }),
  );
});
