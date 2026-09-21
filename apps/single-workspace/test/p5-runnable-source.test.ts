import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactRole,
  DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
  workspaceBound,
} from "@arbor/domain";
import {
  ClockLive,
  DependencyRepositoryLive,
  IdGeneratorLive,
  layer,
  P7_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "@arbor/persistence-sqlite";
import {
  DependencyRepository,
  RunnableWorkSource,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { DependencyAwareRunnableWorkSourceLive } from "../src/runnable-source-p7.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const otherWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789f1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workA = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workB = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a2");
const depA = parse(DependencyId)("dep_018f2b3c-4d5e-7abc-8def-0123456789a1");

const dependencyOn = (consumerWorkId: WorkId) =>
  declareDependency({
    dependencyId: depA,
    consumerWorkId,
    producerBinding: workspaceBound(otherWorkspaceId),
    revision: parse(DependencyRevision)(0),
    expectedDeliverable: {
      kind: parse(DeliverableKind)("report"),
      requiredArtifactRoles: [parse(ArtifactRole)("summary")],
    },
  });

const buildClassifyApp = (databaseFile: string) => {
  const base = Layer.mergeAll(
    layer({ filename: databaseFile }),
    ClockLive,
    IdGeneratorLive,
  );
  const stores = Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    Layer.provide(WorkspaceRepositoryLive, base),
    Layer.provide(WorkRepositoryLive, base),
    Layer.provide(WorkWaitStoreLive, base),
    Layer.provide(DependencyRepositoryLive, base),
  );
  return Layer.mergeAll(
    stores,
    Layer.provide(DependencyAwareRunnableWorkSourceLive, stores),
  );
};

const seed = (current: WorkId | null, waitRows: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
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
          "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
            current,
            "{}",
            0,
            0,
            "Active",
            "t",
            "t",
          ],
        );
        for (const workId of [workA, workB]) {
          yield* sql.unsafe(
            "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              workId,
              projectId,
              workspaceId,
              "o",
              "w",
              "[]",
              "done",
              "{}",
              "{}",
              "Open",
              0,
              "t",
              "t",
            ],
          );
        }
        for (const row of waitRows) {
          yield* sql.unsafe(
            "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?,?,?,?,?)",
            [
              (row as { workId: WorkId }).workId,
              "Any",
              JSON.stringify((row as { conditions: unknown }).conditions),
              "t",
              "t",
            ],
          );
        }
      }),
    );
  });

const classify = (
  current: WorkId | null,
  waitRows: ReadonlyArray<unknown> = [],
  withDependencyOn: WorkId | null = null,
) => {
  const dir = mkdtempSync(join(tmpdir(), "p5-rs-"));
  const app = buildClassifyApp(join(dir, "slice.db"));
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P7_MIGRATIONS);
        yield* seed(current, waitRows);
        if (withDependencyOn !== null) {
          const tx = yield* TransactionPort;
          const deps = yield* DependencyRepository;
          yield* tx.transact(
            deps.insert(dependencyOn(withDependencyOn), projectId),
          );
        }
        const source = yield* RunnableWorkSource;
        return yield* source.classify(workspaceId);
      }),
      app,
    ) as unknown as Effect.Effect<
      {
        current: { _tag: string; value?: string };
        runnable: ReadonlyArray<string>;
      },
      unknown,
      never
    >,
  );
};

describe("P5→P7 RunnableWorkSource (supersession semantics, P7 03 §4)", () => {
  it("classifies the current Open work and the remaining open work", async () => {
    const result = await classify(workA);
    expect(result.current._tag).toBe("Some");
    if (result.current._tag === "Some") {
      expect(result.current.value).toBe(workA);
    }
    expect([...result.runnable]).toEqual([workB]);
  });

  it("treats an unset current work as None and returns all open work", async () => {
    const result = await classify(null);
    expect(result.current._tag).toBe("None");
    expect([...result.runnable].sort()).toEqual([workA, workB].sort());
  });

  it("returns None for a waiting current and excludes it from runnable", async () => {
    const result = await classify(workA, [
      { workId: workA, conditions: [{ _tag: "TimeReached", instant: "t" }] },
    ]);
    expect(result.current._tag).toBe("None");
    expect([...result.runnable]).toEqual([workB]);
  });

  it("keeps an Unsatisfied dependency without a WorkWait runnable (single-negative rule)", async () => {
    const result = await classify(null, [], workB);
    expect(result.current._tag).toBe("None");
    expect([...result.runnable].sort()).toEqual([workA, workB].sort());
  });

  it("excludes a Work blocked by an Unsatisfied dependency its active wait references", async () => {
    const result = await classify(
      workA,
      [
        {
          workId: workB,
          conditions: [
            {
              _tag: "DependencyChanged",
              dependencyId: depA,
              observedRevision: 0,
            },
          ],
        },
      ],
      workB,
    );
    expect(result.current._tag).toBe("Some");
    if (result.current._tag === "Some") {
      expect(result.current.value).toBe(workA);
    }
    expect([...result.runnable]).toEqual([]);
  });
});
