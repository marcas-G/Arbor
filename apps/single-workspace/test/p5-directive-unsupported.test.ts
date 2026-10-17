import {
  Actor,
  type CommandSubmissionContext,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ExecutionDriverPort,
  LeaseService,
  RuntimeSafetyGate,
  TransactionPort,
} from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureLegacyProjectResourceSourceFixture } from "../../../tests/support/legacy-project-resource-source.js";
import {
  createSchema45TestDatabaseFactory as createSchema44TestDatabaseFactory,
  type Schema44TestDatabaseFactory,
} from "../../../tests/support/schema44-database.js";
import { buildSingleWorkspaceLayer } from "../src/index.js";

let schema44Factory: Schema44TestDatabaseFactory | undefined;
const schema44Cleanups: Array<() => void> = [];

beforeAll(async () => {
  schema44Factory = await createSchema44TestDatabaseFactory({
    prefix: ".p5-directive-unsupported-template-",
  });
}, 120_000);

afterAll(() => schema44Factory?.cleanup(), 120_000);

const createSchema44Case = () => {
  if (schema44Factory === undefined) {
    throw new Error("Schema-42 test database factory was not prepared.");
  }
  return schema44Factory.create();
};

afterEach(() => {
  for (const cleanup of schema44Cleanups.splice(0)) cleanup();
}, 120_000);

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");

const legacyDirective = (tag: string, extra: Record<string, unknown> = {}) => ({
  _tag: "ToolCallProposed" as const,
  callRef: `c-${tag}`,
  toolName: "arbor_directive",
  argumentsJson: JSON.stringify({ _tag: tag, ...extra }),
});

const turns = [
  [
    legacyDirective("DeclareDependency", { spec: {} }),
    { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
  ],
];

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
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
        [
          executionId,
          projectId,
          "workspace",
          workspaceId,
          "InboxEpisode",
          "legacy-directive-test",
          0,
          sessionId,
          "t",
        ],
      );
    }),
  );
});

const execution: Execution = {
  executionId,
  projectId,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    episode: {
      _tag: "InboxEpisode",
      entryKey: "legacy-directive-test",
      inputKind: "LegacyDirectiveTest",
    },
  },
  sessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};
const context: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal,
  executionId,
  fencingGeneration: 0 as never,
};

describe("OBSOLETE_CONTRACT_TEST — DirectiveUnsupported universal envelope", () => {
  it("fails closed on an unregistered legacy control envelope", async () => {
    const fixture = createSchema44Case();
    schema44Cleanups.push(fixture.cleanup);
    const app = buildSingleWorkspaceLayer({
      databaseFile: fixture.databaseFilename,
      providerTurns: turns,
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed;
          yield* ensureLegacyProjectResourceSourceFixture();
          const tx = yield* TransactionPort;
          const leases = yield* LeaseService;
          yield* tx.transact(leases.acquire(executionId, "worker:a", "inc-a"));
          const driver = yield* ExecutionDriverPort;
          const gate = yield* RuntimeSafetyGate;
          const settlement = yield* driver.drive({
            execution,
            agentExecutionState: {
              executionId,
              focus: { _tag: "Coordination" },
              wakeReason: { _tag: "WorkSelected" },
              currentMode: "execute",
              activeSkillRefs: [],
              turnNo: 0,
              recentDirectiveRefs: [],
              recentActionFingerprints: [],
              updatedAt: "t",
            },
            wakeReason: { _tag: "WorkSelected" },
            context,
            safetyGate: gate,
          });
          const sql = yield* SqlClient;
          const entries = yield* sql.unsafe<{ payload_json: string }>(
            "SELECT payload_json FROM session_entries WHERE session_id = ?",
            [sessionId],
          );
          return { settlement, entries: entries.map((e) => e.payload_json) };
        }),
        app,
      ) as unknown as Effect.Effect<
        {
          settlement: { _tag: string; result?: { _tag: string } };
          entries: ReadonlyArray<string>;
        },
        unknown,
        never
      >,
    );
    expect(result.settlement).toMatchObject({
      _tag: "Interrupted",
      result: {
        _tag: "ControlledInterruption",
        reason: "UnknownTool",
      },
    });
    expect(
      result.entries.some((entry) => entry.includes("DirectiveUnsupported")),
    ).toBe(false);
    void actor;
  }, 120_000);
});
