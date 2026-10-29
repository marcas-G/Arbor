import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7TestActor,
} from "../../../tests/support/p7-app.js";
import {
  isP39PathQualificationEnabled,
  p39WindowsAclQualificationAvailable,
} from "../../../tests/support/p39-windows-deployment-test.js";
import { createCurrentSchemaTestDatabaseFactory } from "../../../tests/support/schema44-database.js";
import { buildSingleWorkspaceLayer } from "../src/composition.js";
import { runDaemonOnce } from "../src/main.js";

const p39PathQualificationAvailable = isP39PathQualificationEnabled(
  process.platform,
  p39WindowsAclQualificationAvailable(),
);

const projectId = p7Project;
const childWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a2";
const childSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a2";
const childWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789a2";
let fixtureFactory:
  | Awaited<ReturnType<typeof createCurrentSchemaTestDatabaseFactory>>
  | undefined;
let fixture:
  | ReturnType<NonNullable<typeof fixtureFactory>["create"]>
  | undefined;

beforeAll(async () => {
  fixtureFactory = await createCurrentSchemaTestDatabaseFactory({
    prefix: ".blocked-workepisode-current-schema-",
  });
}, 120_000);

beforeEach(() => {
  if (fixtureFactory === undefined)
    throw new Error("Current schema factory is missing");
  fixture = fixtureFactory.create();
});

afterEach(() => {
  const current = fixture;
  fixture = undefined;
  try {
    current?.cleanup();
  } finally {
    fixture = undefined;
  }
});

afterAll(() => {
  fixtureFactory?.cleanup();
  fixtureFactory = undefined;
});

const databaseFile = () => {
  if (fixture === undefined)
    throw new Error("Current schema fixture is missing");
  return fixture.databaseFilename;
};

const seedDurableBlockedState = Effect.gen(function* () {
  yield* p7SeedProject;
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
        [childSessionId, childWorkspaceId],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,'child','{}',0,'{}',0,'{}',?,?, '{}',0,0,'Active','t','t')",
        [
          childWorkspaceId,
          projectId,
          p7RootWorkspace,
          childSessionId,
          childWorkId,
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,'child work','blocked','[]','done','{}','{}','Open',0,'t','t')",
        [childWorkId, projectId, childWorkspaceId],
      );
      // Model the durable post-offset state of the WorkBlocked P6 transaction:
      // Parent Inbox admitted, child InboxAdvanced wait cleared, and source
      // signal offset advanced together before the process stops.
      yield* sql.unsafe(
        "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at, revision, updated_at) VALUES (?, 'blocked:child-work', 'WorkBlocked', 'Child Work is blocked', 'blocker-fingerprint', 't', NULL, 1, 't')",
        [p7RootWorkspace],
      );
      yield* sql.unsafe(
        "INSERT INTO consumer_offsets (consumer_id, project_id, last_sequence, updated_at) VALUES ('workflow-signals', ?, 1, 't')",
        [projectId],
      );
    }),
  );
});

const executionCount = (workspaceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM executions WHERE workspace_id = ?",
      [workspaceId],
    );
    return Number(rows[0]?.count ?? 0);
  });

const runWithDatabase = <A, R>(
  filename: string,
  program: Effect.Effect<A, unknown, R>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program,
        buildSingleWorkspaceLayer({
          databaseFile: filename,
          providerTurns: [],
        }),
      ) as Effect.Effect<A, unknown, never>,
    ),
  );

describe.skipIf(!p39PathQualificationAvailable)(
  "Blocked WorkEpisode restart readmission",
  () => {
    it("global scheduler re-admits durable Parent Inbox after the source offset already advanced", async () => {
      const filename = databaseFile();
      try {
        const outcome = await runWithDatabase(
          filename,
          Effect.gen(function* () {
            yield* seedDurableBlockedState;
            yield* runDaemonOnce({ principalRef: String(p7TestActor) });
            return {
              parentExecutions: yield* executionCount(p7RootWorkspace),
            };
          }),
        );
        expect(outcome.parentExecutions).toBeGreaterThan(0);
      } finally {
        const current = fixture;
        fixture = undefined;
        current?.cleanup();
      }
    }, 120_000);

    it("child scope processes its own Open Work but preserves Parent Inbox until Parent/global scope runs", async () => {
      const filename = databaseFile();
      try {
        const outcome = await runWithDatabase(
          filename,
          Effect.gen(function* () {
            yield* seedDurableBlockedState;
            yield* runDaemonOnce({
              workspaceId: childWorkspaceId as never,
              principalRef: String(p7TestActor),
            });
            const sql = yield* SqlClient;
            const parentInboxBefore = yield* sql.unsafe<{
              consumed_at: string | null;
            }>(
              "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = 'blocked:child-work'",
              [p7RootWorkspace],
            );
            const childExecutions = yield* executionCount(childWorkspaceId);
            const parentBefore = yield* executionCount(p7RootWorkspace);

            yield* runDaemonOnce({
              workspaceId: p7RootWorkspace,
              principalRef: String(p7TestActor),
            });
            return {
              parentInboxBefore,
              childExecutions,
              parentBefore,
              parentAfter: yield* executionCount(p7RootWorkspace),
            };
          }),
        );
        expect(outcome.childExecutions).toBeGreaterThan(0);
        expect(outcome.parentBefore).toBe(0);
        expect(outcome.parentInboxBefore).toEqual([{ consumed_at: null }]);
        expect(outcome.parentAfter).toBeGreaterThan(0);
      } finally {
        const current = fixture;
        fixture = undefined;
        current?.cleanup();
      }
    }, 120_000);
  },
);
