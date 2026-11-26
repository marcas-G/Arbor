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
  AcceptanceRepositoryLive,
  ClockLive,
  CompletionHoldReadLive,
  DependencyRepositoryLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  layer,
  P12_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
  VerificationRepositoryLive,
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
import { NoHoldWorkReadmissionGateStoreLive } from "../../../packages/testkit/src/index.js";
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
const passVerificationId = "ver_018f2b3c-4d5e-7abc-8def-0123456789a1";
const completionExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a1";

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
    Layer.provide(ExecutionRepositoryLive, base),
    Layer.provide(VerificationRepositoryLive, base),
    Layer.provide(AcceptanceRepositoryLive, base),
    Layer.provide(WorkWaitStoreLive, base),
    Layer.provide(DependencyRepositoryLive, base),
    NoHoldWorkReadmissionGateStoreLive,
  );
  return Layer.mergeAll(
    stores,
    Layer.provide(
      DependencyAwareRunnableWorkSourceLive,
      Layer.mergeAll(stores, Layer.provide(CompletionHoldReadLive, base)),
    ),
  );
};

const seed = (
  current: WorkId | null,
  waitRows: ReadonlyArray<unknown> = [],
  options: {
    readonly passVerification?: boolean;
    readonly acceptance?: boolean;
    readonly completionClaimed?: boolean;
    readonly verificationVerdict?: "Pass" | "Fail" | "Unknown";
    readonly workRevision?: number;
    readonly verificationTargetRevision?: number;
  } = {},
) =>
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
              JSON.stringify({
                goal: "verify",
                criteria: [
                  {
                    criterionId: "criterion",
                    requirement: "the work is verifiable",
                    required: true,
                  },
                ],
                riskRequirements: [],
              }),
              "{}",
              "Open",
              workId === workA ? (options.workRevision ?? 0) : 0,
              "t",
              "t",
            ],
          );
        }
        if (options.passVerification === true) {
          const mission = JSON.stringify({
            goal: "verify",
            criteria: [
              {
                criterionId: "criterion",
                requirement: "the work is verifiable",
                required: true,
              },
            ],
            riskRequirements: [],
          });
          yield* sql.unsafe(
            "INSERT INTO verifications (verification_id, project_id, work_id, target_work_revision, owner_workspace_id, mission_snapshot, target_deliverables, target_artifact_versions, target_environment_revision, environment_snapshot_ref, verification_execution_ids, state, verdict, conclusion_reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              passVerificationId,
              projectId,
              workA,
              options.verificationTargetRevision ?? 0,
              workspaceId,
              mission,
              "[]",
              "[]",
              null,
              null,
              "[]",
              "Concluded",
              options.verificationVerdict ?? "Pass",
              null,
              "t",
              "t",
            ],
          );
          if (options.acceptance === true) {
            yield* sql.unsafe(
              "INSERT INTO work_acceptances (acceptance_id, project_id, work_id, target_work_revision, verification_id, actor, accepted_at) VALUES (?,?,?,?,?,?,?)",
              [
                "acc_018f2b3c-4d5e-7abc-8def-0123456789a1",
                projectId,
                workA,
                0,
                passVerificationId,
                "user:test",
                "t",
              ],
            );
          }
        }
        if (options.completionClaimed === true) {
          yield* sql.unsafe(
            "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              completionExecutionId,
              projectId,
              "workspace",
              workspaceId,
              "work",
              workA,
              null,
              null,
              sessionId,
              "t",
              null,
              "Completed",
              JSON.stringify({
                _tag: "Completed",
                result: {
                  _tag: "CompletionClaimed",
                  workRevision: options.workRevision ?? 0,
                  claimRef: "clm_018f2b3c-4d5e-7abc-8def-0123456789a1",
                },
              }),
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
  options: {
    readonly passVerification?: boolean;
    readonly acceptance?: boolean;
    readonly completionClaimed?: boolean;
    readonly verificationVerdict?: "Pass" | "Fail" | "Unknown";
    readonly workRevision?: number;
    readonly verificationTargetRevision?: number;
  } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "p5-rs-"));
  const app = buildClassifyApp(join(dir, "slice.db"));
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* seed(current, waitRows, options);
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

describe("→RunnableWorkSource (supersession semantics, 03 §4)", () => {
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

  it("holds a PASSed current Work until Acceptance instead of re-running it", async () => {
    const result = await classify(workA, [], null, { passVerification: true });
    expect(result.current._tag).toBe("None");
    expect([...result.runnable]).toEqual([workB]);
  });

  it("holds a CompletionClaimed Work until verification starts", async () => {
    const result = await classify(workA, [], null, {
      completionClaimed: true,
    });
    expect(result.current._tag).toBe("None");
    expect([...result.runnable]).toEqual([workB]);
  });

  it("also holds an accepted Open Work until CompleteWork is consumed", async () => {
    const result = await classify(workA, [], null, {
      passVerification: true,
      acceptance: true,
    });
    expect(result.current._tag).toBe("None");
    expect([...result.runnable]).toEqual([workB]);
  });

  it.each(["Fail", "Unknown"] as const)(
    "keeps a %s Verification runnable for explicit recovery",
    async (verificationVerdict) => {
      const result = await classify(workA, [], null, {
        completionClaimed: true,
        passVerification: true,
        verificationVerdict,
      });
      expect(result.current._tag).toBe("Some");
      expect(result.runnable).toEqual([workB]);
    },
  );

  it("does not hold a PASS from an older Work revision", async () => {
    const result = await classify(workA, [], null, {
      passVerification: true,
      workRevision: 1,
      verificationTargetRevision: 0,
    });
    expect(result.current._tag).toBe("Some");
    expect(result.runnable).toEqual([workB]);
  });
});
