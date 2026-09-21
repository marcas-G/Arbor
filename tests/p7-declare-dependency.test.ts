import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type DeclareDependencyPayload,
  type DeclareDependencyResult,
  makeDeclareDependencyHandler,
} from "../packages/application/src/commands/declare-dependency.js";
import type {
  CommandOutcome,
  CommandResult,
  GatewayEnvelope,
} from "../packages/application/src/index.js";
import {
  CommandId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  ProjectId,
  parse,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  DependencyRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const UNKNOWN_WORK = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ff");
const UNKNOWN_WS = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789fe",
);
const OTHER_PROJECT = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c4",
);
const OTHER_ROOT = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789f4",
);
const OTHER_SESSION = "ses_018f2b3c-4d5e-7abc-8def-0123456789f5";
const OTHER_WORK = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789f6");

const DEP = (suffix: string) =>
  parse(DependencyId)(`dep_00000000-0000-7000-8000-00000000${suffix}`);
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
const ASSIGN_CMD = CMD("0123456789a1");

const KIND = "report" as never as DeliverableKind;
const ROLES = ["summary" as never];

const seed = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

/** Forges a second Project with one workspace and one Open Work, for the
 * cross-Project producer-binding rejections (p6-send-message row-forging
 * pattern: deferrable workspace→session / project→workspace FKs share one
 * transaction; works→workspaces FK is immediate, so the workspace lands
 * first). */
const seedOtherProject = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          OTHER_PROJECT,
          "other",
          OTHER_ROOT,
          JSON.stringify({}),
          0,
          JSON.stringify({}),
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          OTHER_ROOT,
          OTHER_PROJECT,
          null,
          "other-root",
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
            workspaceId: OTHER_ROOT,
          }),
          OTHER_SESSION,
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
        [OTHER_SESSION, "WorkspacePrimary", OTHER_ROOT, null, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          OTHER_WORK,
          OTHER_PROJECT,
          OTHER_ROOT,
          "other",
          "cross-project forge",
          "[]",
          "any",
          JSON.stringify({ goal: "g", criteria: [], riskRequirements: [] }),
          JSON.stringify({ predecessorWorkId: null, reason: "forge" }),
          "Open",
          0,
          "t",
          "t",
        ],
      );
    }),
  );
});

const makeHandler = Effect.gen(function* () {
  const works = yield* WorkRepository;
  const workspaces = yield* WorkspaceRepository;
  const dependencies = yield* DependencyRepository;
  return makeDeclareDependencyHandler({ works, workspaces, dependencies });
});

const payloadOf = (
  dependencyId: DependencyId,
  overrides: Partial<DeclareDependencyPayload> = {},
): DeclareDependencyPayload => ({
  dependencyId,
  consumerWorkId: WORK_1,
  producerBinding: { _tag: "AnyProducer" },
  expectedDeliverable: { kind: KIND, requiredArtifactRoles: ROLES },
  expectedConsumerWorkRevision: parse(WorkRevision)(0),
  revision: parse(DependencyRevision)(0),
  ...overrides,
});

const envelopeOf = (
  commandId: CommandId,
  payload: DeclareDependencyPayload,
): GatewayEnvelope<DeclareDependencyPayload> => ({
  commandType: "DeclareDependency",
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

type Outcome = CommandResult<CommandOutcome<DeclareDependencyResult>>;

const expectRejected = (outcome: Outcome, tag: string) => {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.error._tag).toBe(tag);
  }
};

describe("p7-declare-dependency", () => {
  it("declares an Unsatisfied dependency at revision 0 with a DependencyDeclared event", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const dep = DEP("0001");
        const outcome = yield* tx.transact(
          handler.execute(envelopeOf(CMD("0123456789d1"), payloadOf(dep)), {
            _tag: "External",
            principal: p7TestPrincipal,
          }),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            dependencyId: dep,
            consumerWorkId: WORK_1,
            state: "Unsatisfied",
            revision: 0,
          });
          expect(outcome.value.events).toHaveLength(1);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("DependencyDeclared");
          expect(event.aggregateRef).toBe(dep);
          expect(event.payload).toEqual({
            dependencyId: dep,
            consumerWorkId: WORK_1,
            producerBinding: { _tag: "AnyProducer" },
            expectedDeliverable: { kind: KIND, requiredArtifactRoles: ROLES },
            revision: 0,
          });
        }
        const deps = yield* DependencyRepository;
        const stored = yield* tx.transact(deps.findById(dep));
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(stored.value.state).toBe("Unsatisfied");
          expect(stored.value.revision).toBe(0);
          expect(stored.value.consumerWorkId).toBe(WORK_1);
        }
      }),
      makeP7App(),
    );
  });

  it("rejects WorkNotFound when the consumer work does not exist", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d2"),
              payloadOf(DEP("0002"), {
                consumerWorkId: UNKNOWN_WORK,
              }),
            ),
            { _tag: "External", principal: p7TestPrincipal },
          ),
        );
        expectRejected(outcome, "WorkNotFound");
      }),
      makeP7App(),
    );
  });

  it("rejects TerminalLifecycleMutation(Work) when the consumer work is Cancelled", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE works SET lifecycle = 'Cancelled' WHERE work_id = ?",
            [WORK_1],
          ),
        );
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789d3"), payloadOf(DEP("0003"))),
            { _tag: "External", principal: p7TestPrincipal },
          ),
        );
        expectRejected(outcome, "TerminalLifecycleMutation");
      }),
      makeP7App(),
    );
  });

  it("rejects RevisionConflict on a stale expectedConsumerWorkRevision", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d4"),
              payloadOf(DEP("0004"), {
                expectedConsumerWorkRevision: parse(WorkRevision)(5),
              }),
            ),
            { _tag: "External", principal: p7TestPrincipal },
          ),
        );
        expectRejected(outcome, "RevisionConflict");
      }),
      makeP7App(),
    );
  });

  it("rejects TerminalLifecycleMutation(Workspace) when the consumer work's workspace is Retired", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE workspaces SET lifecycle = 'Retired' WHERE workspace_id = ?",
            [p7RootWorkspace],
          ),
        );
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789d5"), payloadOf(DEP("0005"))),
            { _tag: "External", principal: p7TestPrincipal },
          ),
        );
        expectRejected(outcome, "TerminalLifecycleMutation");
      }),
      makeP7App(),
    );
  });

  it("rejects cross-Project / missing producer binding targets with AuthorityDenied", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedOtherProject;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const context = {
          _tag: "External",
          principal: p7TestPrincipal,
        } as const;
        const crossWorkspace = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789e1"),
              payloadOf(DEP("0006"), {
                producerBinding: {
                  _tag: "WorkspaceBound",
                  workspaceId: OTHER_ROOT,
                },
              }),
            ),
            context,
          ),
        );
        const missingWorkspace = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789e2"),
              payloadOf(DEP("0007"), {
                producerBinding: {
                  _tag: "WorkspaceBound",
                  workspaceId: UNKNOWN_WS,
                },
              }),
            ),
            context,
          ),
        );
        const crossWork = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789e3"),
              payloadOf(DEP("0008"), {
                producerBinding: { _tag: "WorkBound", workId: OTHER_WORK },
              }),
            ),
            context,
          ),
        );
        const missingWork = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789e4"),
              payloadOf(DEP("0009"), {
                producerBinding: { _tag: "WorkBound", workId: UNKNOWN_WORK },
              }),
            ),
            context,
          ),
        );
        expectRejected(crossWorkspace, "AuthorityDenied");
        expectRejected(missingWorkspace, "AuthorityDenied");
        expectRejected(crossWork, "AuthorityDenied");
        expectRejected(missingWork, "AuthorityDenied");
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM dependencies",
        );
        expect(Number(rows[0]?.count ?? 0)).toBe(0);
      }),
      makeP7App(),
    );
  });
});
