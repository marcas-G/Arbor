import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P6_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { makeSpawnSpecialistHandler } from "../apps/single-workspace/src/directives.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  CommandId,
  type ExecutionId,
  ExecutionId as ExeId,
  LeaseGeneration,
  parse,
  parse as parse2,
  SessionId,
} from "../packages/domain/dist/index.js";
import {
  Clock,
  FormationProposalStore,
  TransactionPort,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  makeP6App,
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestPrincipal,
  runP6,
} from "./support/p6-app.js";

const admitMainExecution = Effect.gen(function* () {
  const gw = yield* CommandGateway;
  const executionId = parse2(ExeId)("exe_018f2b3c-4d5e-7abc-8def-0123456789e1");
  const sessionId = parse2(SessionId)(
    "ses_018f2b3c-4d5e-7abc-8def-0123456789e1",
  );
  const commandId = parse2(CommandId)(
    "cmd_018f2b3c-4d5e-7abc-8def-0123456789f1",
  );
  const payload = {
    _tag: "WorkspaceMain" as const,
    executionId,
    workspaceId: p6RootWorkspace,
    focus: { _tag: "Coordination" as const },
  };
  const receipt = yield* gw.execute(
    {
      commandType: "AdmitExecution",
      commandId,
      projectId: p6Project,
      actor: p6TestPrincipal as never,
      issuedAt: "t",
      payload,
    },
    { _tag: "System", principal: p6TestPrincipal, causationRef: "test" },
    {
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "System",
      principal: p6TestPrincipal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AdmitExecution",
        projectId: p6Project,
        actor: p6TestPrincipal as never,
        schemaVersion: "1",
        payload,
      }),
      projectId: p6Project,
      commandKind: "AdmitExecution",
      workspaceId: p6RootWorkspace,
      bindingKind: "WorkspaceMain",
    },
  );
  expect(receipt.resolution._tag).toBe("Committed");
  return executionId;
});

const executionOf =
  (stopRequestedAt: string | null) => (admittedExecutionId: ExecutionId) => ({
    executionId: admittedExecutionId,
    projectId: p6Project,
    workspaceId: p6RootWorkspace,
    binding: {
      _tag: "WorkspaceExecution" as const,
      workspaceId: p6RootWorkspace,
      focus: { _tag: "Coordination" as const },
    },
    sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789c1" as never,
    admittedAt: "t",
    stopRequestedAt,
    state: { status: "Active" as const, settlement: null },
  });

const executionContext = Effect.gen(function* () {
  const mainExecutionId = yield* admitMainExecution;
  return {
    _tag: "ExecutionOrigin" as const,
    principal: p6TestPrincipal,
    executionId: mainExecutionId,
    fencingGeneration: parse(LeaseGeneration)(0),
  };
});

const countRows = (table: string, where = "") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} ${where}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

const makeHandler = Effect.gen(function* () {
  return makeSpawnSpecialistHandler({
    gateway: yield* CommandGateway,
    workspaces: yield* WorkspaceRepository,
    proposals: yield* FormationProposalStore,
    tx: yield* TransactionPort,
    clock: yield* Clock,
  });
});

describe("P6-007 SpawnSpecialist (DID v1.7 G5)", () => {
  it("admits an ExecutionBound specialist with an atomic ExecutionScoped session", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* p6SeedProject;
      const mainExecutionId = yield* admitMainExecution;
      const handler = yield* makeHandler;
      const outcome = yield* handler.handle({
        directive: {
          _tag: "SpawnSpecialist",
          spec: { mission: "scan the tree", constraints: [], skillIds: [] },
        },
        execution: executionOf(null)(mainExecutionId),
        context: yield* executionContext,
      });
      const executions = yield* countRows(
        "executions",
        "WHERE binding_kind = 'execution_bound'",
      );
      const scoped = yield* countRows(
        "sessions",
        "WHERE binding_kind = 'ExecutionScoped'",
      );
      return { outcome, executions, scoped };
    });
    const result = await runP6(program, makeP6App());
    expect(result.outcome._tag).toBe("Observation");
    if (result.outcome._tag === "Observation") {
      expect(result.outcome.observation.text).toContain("specialist admitted");
    }
    expect(result.executions).toBe(1);
    expect(result.scoped).toBe(1); // atomically created with the execution
  });

  it("refuses new spawn admission once stop has been requested (quiescence)", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* p6SeedProject;
      const mainExecutionId = yield* admitMainExecution;
      const handler = yield* makeHandler;
      const outcome = yield* handler.handle({
        directive: {
          _tag: "SpawnSpecialist",
          spec: { mission: "too late", constraints: [], skillIds: [] },
        },
        execution: executionOf("2026-09-21T00:00:00.000Z")(mainExecutionId),
        context: yield* executionContext,
      });
      const executions = yield* countRows(
        "executions",
        "WHERE binding_kind = 'execution_bound'",
      );
      return { outcome, executions };
    });
    const result = await runP6(program, makeP6App());
    expect(result.outcome._tag).toBe("Observation");
    if (result.outcome._tag === "Observation") {
      expect(result.outcome.observation.text).toContain("quiescence");
    }
    expect(result.executions).toBe(0);
  });

  it("malformed spec is a non-fatal observation", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* p6SeedProject;
      const mainExecutionId = yield* admitMainExecution;
      const handler = yield* makeHandler;
      return yield* handler.handle({
        directive: { _tag: "SpawnSpecialist", spec: { mission: "" } },
        execution: executionOf(null)(mainExecutionId),
        context: yield* executionContext,
      });
    });
    const outcome = await runP6(program, makeP6App());
    expect(outcome._tag).toBe("Observation");
    if (outcome._tag === "Observation") {
      expect(outcome.observation.text).toContain("malformed");
    }
  });
});
