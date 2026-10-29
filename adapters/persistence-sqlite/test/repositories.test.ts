import {
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import {
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  layer,
  P1_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../src/index.js";

const base = layer({ filename: ":memory:" });
const repos = Layer.mergeAll(
  ProjectRepositoryLive,
  WorkspaceRepositoryLive,
  WorkRepositoryLive,
  SessionRepositoryLive,
);
const app = Layer.mergeAll(
  base,
  ClockLive,
  Layer.provide(TransactionPortLive, base),
  Layer.provide(repos, Layer.merge(base, ClockLive)),
);

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};
const boundary = {
  basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
  addresses: [],
};

const program = Effect.gen(function* () {
  yield* runMigrations(P1_MIGRATIONS);
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    `ALTER TABLE projects ADD COLUMN resource_source_json TEXT NOT NULL DEFAULT '{"_tag":"LegacyUnknown"}' CHECK (json_valid(resource_source_json))`,
  );
  const tx = yield* TransactionPort;
  const sessions = yield* SessionRepository;
  const workspaces = yield* WorkspaceRepository;
  const projects = yield* ProjectRepository;
  const works = yield* WorkRepository;

  return yield* tx.transact(
    Effect.gen(function* () {
      yield* projects.create({
        projectId,
        name: "Arbor",
        rootWorkspaceId: workspaceId,
        projectPolicy: makeProjectPolicy(),
        projectPolicyRevision: parse(Revision)(0),
        defaultConfiguration: {},
        environmentRef: "local",
        resourceSource: {
          _tag: "Profile",
          resourceProfileRef: "repo-default",
          version: "7",
        },
        lifecycle: "Open",
        revision: parse(Revision)(0),
      });
      yield* workspaces.create({
        workspaceId,
        projectId,
        parentWorkspaceId: null,
        name: "root",
        responsibilityDefinition: definition,
        responsibilityRevision: parse(ResponsibilityRevision)(0),
        resourceBoundary: boundary,
        resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
        agentBinding: responsibilityBound(workspaceId),
        primarySessionId: sessionId,
        currentWorkId: null,
        workspacePolicy: makeWorkspacePolicy(),
        workspacePolicyRevision: parse(Revision)(0),
        revision: parse(Revision)(0),
        lifecycle: "Active",
      });
      yield* sessions.create({
        sessionId,
        binding: { _tag: "WorkspacePrimary", workspaceId },
        contextEpoch: parse(ContextEpochNumber)(0),
        entries: [],
        checkpoints: [],
        providerContinuation: { state: null },
        modelContinuation: null,
      });
      yield* works.create({
        workId,
        projectId,
        workspaceId,
        objective: "ship",
        why: "P1",
        constraints: [],
        completionExpectation: "green",
        verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
        provenance: { predecessorWorkId: null, reason: "initial" },
        lifecycle: "Open",
        revision: parse(WorkRevision)(0),
      });

      const loadedProject = yield* projects.findById(projectId);
      const loadedWorkspace = yield* workspaces.findById(workspaceId);
      const loadedWork = yield* works.findById(workId);
      const loadedSession = yield* sessions.findById(sessionId);
      const resourceSourceDecodeFailures: Array<string | undefined> = [];
      yield* sql.unsafe("PRAGMA ignore_check_constraints = ON");
      for (const invalidSource of [
        "not-json",
        `{"_tag":"Unknown"}`,
        `{"_tag":"ConversationOnly","path":"C:/private"}`,
        `{"_tag":"Profile","resourceProfileRef":"","version":"7"}`,
      ]) {
        yield* sql.unsafe(
          "UPDATE projects SET resource_source_json = ? WHERE project_id = ?",
          [invalidSource, projectId],
        );
        const decodeError = yield* Effect.flip(projects.findById(projectId));
        resourceSourceDecodeFailures.push(decodeError._tag);
      }
      yield* sql.unsafe("PRAGMA ignore_check_constraints = OFF");
      yield* sql.unsafe(
        "UPDATE projects SET resource_source_json = ? WHERE project_id = ?",
        [
          JSON.stringify({
            _tag: "Profile",
            resourceProfileRef: "repo-default",
            version: "7",
          }),
          projectId,
        ],
      );

      const updated = yield* projects.updatePolicyIfRevision(
        projectId,
        parse(Revision)(0),
        makeProjectPolicy({ ceiling: "strict" }),
        parse(Revision)(1),
        parse(Revision)(1),
      );
      const conflicted = yield* Effect.exit(
        projects.updatePolicyIfRevision(
          projectId,
          parse(Revision)(0),
          makeProjectPolicy(),
          parse(Revision)(1),
          parse(Revision)(1),
        ),
      );
      const openWork = yield* workspaces.hasOpenWork(workspaceId);
      const activeChildren = yield* workspaces.countActiveChildren(workspaceId);

      return {
        project: Option.isSome(loadedProject),
        projectSource: Option.isSome(loadedProject)
          ? loadedProject.value.resourceSource
          : undefined,
        resourceSourceDecodeFailures,
        workspace: Option.isSome(loadedWorkspace),
        work: Option.isSome(loadedWork),
        session: Option.isSome(loadedSession),
        updated,
        conflicted,
        openWork,
        activeChildren,
      };
    }),
  );
});

describe("repositories", () => {
  it("round-trips aggregates and enforces CAS", async () => {
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.project).toBe(true);
    expect(result.projectSource).toEqual({
      _tag: "Profile",
      resourceProfileRef: "repo-default",
      version: "7",
    });
    expect(result.resourceSourceDecodeFailures).toEqual([
      "PersistenceCorruption",
      "PersistenceCorruption",
      "PersistenceCorruption",
      "PersistenceCorruption",
    ]);
    expect(result.workspace).toBe(true);
    expect(result.work).toBe(true);
    expect(result.session).toBe(true);
    expect(result.updated).toBeUndefined();
    expect(result.conflicted._tag).toBe("Failure");
    expect(result.openWork).toBe(true);
    expect(result.activeChildren).toBe(0);
  });
});
