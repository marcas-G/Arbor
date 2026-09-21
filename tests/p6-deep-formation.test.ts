import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P6_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { makeProposeChildWorkspaceHandler } from "../apps/single-workspace/src/directives.js";
import {
  CommandGateway,
  formationPathOf,
  isChildWorkspaceProposal,
} from "../packages/application/src/index.js";
import {
  ExecutionId,
  LeaseGeneration,
  parse,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  Clock,
  FormationProposalStore,
  TransactionPort,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import { minimalProposal } from "./harness/p6-fixtures.js";
import {
  makeP6App,
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestPrincipal,
  runP6,
} from "./support/p6-app.js";

const CHILD = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789c2");
const CHILD_SESSION = "ses_018f2b3c-4d5e-7abc-8def-0123456789c2" as never;

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

const executionOf = (
  workspaceId: WorkspaceId,
): import("../packages/domain/dist/index.js").Execution => ({
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789e1"),
  projectId: p6Project,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId,
    focus: { _tag: "Coordination" as const },
  },
  sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789c1" as never,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active" as const, settlement: null },
});

const executionContext = {
  _tag: "ExecutionOrigin" as const,
  principal: p6TestPrincipal,
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789e1"),
  fencingGeneration: parse(LeaseGeneration)(0),
};

const seedChildWorkspace = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  // Create a depth-1 child of root so the child can propose deep-layer.
  // Wrapped in one transaction: the workspace→session FK is DEFERRABLE.
  yield* tx.transact(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          CHILD,
          p6Project,
          p6RootWorkspace,
          "child",
          JSON.stringify({
            purpose: "p",
            ownedResponsibilities: [],
            obligations: [],
            includes: [],
            excludes: [],
            interfaces: [],
          }),
          1,
          JSON.stringify({ basisResponsibilityRevision: 1, addresses: [] }),
          1,
          JSON.stringify({
            _tag: "ResponsibilityBound",
            workspaceId: CHILD,
          }),
          CHILD_SESSION,
          JSON.stringify({}),
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
        [CHILD_SESSION, "WorkspacePrimary", CHILD, null, 0, "t"],
      );
    }),
  );
});

describe("P6-005 formation path + payload shape (unit)", () => {
  it("depth is pure structure: root proposer gates, non-root is deep", () => {
    expect(formationPathOf({ parentWorkspaceId: null })).toBe("FirstLayer");
    expect(formationPathOf({ parentWorkspaceId: p6RootWorkspace })).toBe(
      "DeepLayer",
    );
  });

  it("validates the model-supplied proposal payload structurally", () => {
    expect(
      isChildWorkspaceProposal({
        name: "a",
        rationale: "r",
        responsibilityDraft: {},
        resourceBoundaryDraft: {},
      }),
    ).toBe(true);
    expect(isChildWorkspaceProposal({ name: "", rationale: "r" })).toBe(false);
    expect(isChildWorkspaceProposal("nope")).toBe(false);
    expect(isChildWorkspaceProposal(null)).toBe(false);
    expect(isChildWorkspaceProposal(undefined)).toBe(false);
  });
});

describe("P6-005 ProposeChildWorkspace handler (Story B core)", () => {
  it("deep layer: a non-root execution forms the workspace directly, no gate", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* p6SeedProject;
      yield* seedChildWorkspace;
      const handler = makeProposeChildWorkspaceHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      const outcome = yield* handler.handle({
        directive: {
          _tag: "ProposeChildWorkspace",
          spec: minimalProposal(),
        },
        execution: executionOf(CHILD),
        context: executionContext,
      });
      const workspaces = yield* countRows("workspaces");
      const works = yield* countRows("works");
      const sql = yield* SqlClient;
      const pendingRows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM formation_proposals WHERE state = 'Pending'",
      );
      return {
        outcome,
        workspaces,
        works,
        pendingCount: Number(pendingRows[0]?.count ?? 0),
      };
    });
    const result = await runP6(program, makeP6App());
    expect(result.outcome._tag).toBe("Observation");
    if (result.outcome._tag === "Observation") {
      expect(result.outcome.observation.text).toContain("deep layer");
    }
    expect(result.workspaces).toBe(3); // root + child + grandchild
    expect(result.works).toBe(1); // initialWork assigned
    expect(result.pendingCount).toBe(0); // no governance record (gate-free)
  });

  it("first layer: a root execution admits a Pending proposal and creates nothing", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* p6SeedProject;
      const handler = makeProposeChildWorkspaceHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      const outcome = yield* handler.handle({
        directive: {
          _tag: "ProposeChildWorkspace",
          spec: minimalProposal(),
        },
        execution: executionOf(p6RootWorkspace),
        context: executionContext,
      });
      const workspaces = yield* countRows("workspaces");
      const sql = yield* SqlClient;
      const pendingRows = yield* sql.unsafe<{
        count: number;
        parent: string;
      }>(
        "SELECT COUNT(*) AS count FROM formation_proposals WHERE state = 'Pending' AND parent_workspace_id = ?",
        [p6RootWorkspace],
      );
      return {
        outcome,
        workspaces,
        pendingCount: Number(pendingRows[0]?.count ?? 0),
      };
    });
    const result = await runP6(program, makeP6App());
    expect(result.outcome._tag).toBe("Observation");
    if (result.outcome._tag === "Observation") {
      expect(result.outcome.observation.text).toContain("human approval");
    }
    expect(result.workspaces).toBe(1); // root only — gate holds creation
    expect(result.pendingCount).toBe(1); // Pending proposal admitted for root
  });

  it("malformed spec is a non-fatal runtime observation", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* p6SeedProject;
      const handler = makeProposeChildWorkspaceHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      return yield* handler.handle({
        directive: { _tag: "ProposeChildWorkspace", spec: { name: 42 } },
        execution: executionOf(p6RootWorkspace),
        context: executionContext,
      });
    });
    const outcome = await runP6(program, makeP6App());
    expect(outcome._tag).toBe("Observation");
    if (outcome._tag === "Observation") {
      expect(outcome.observation.text).toContain("malformed");
    }
  });
});
