import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ProjectId,
  parse,
  WorkId,
} from "../../../packages/domain/dist/index.js";
import {
  type AttentionRow,
  deriveProjectAttention,
} from "../../../packages/projection-runtime/src/index.js";
import {
  insertExecutionRow,
  insertProjectRootRow,
  insertWaitRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Project,
  p10Root,
  runP10,
  seedCanonical,
  setCurrentWork,
  snapshotDatabase,
} from "../../support/p10-fixture.js";

const projectId = parse(ProjectId)(p10Project);
const consumerWorkId = parse(WorkId)(
  "wrk_00000000-0000-7000-8000-0000000000f1",
);
const dependencyId = "dep_s3_any_producer_stalled";

const deriveAnyProducerAttention = async (
  dependencyRevision: number,
  observedRevision: number,
): Promise<ReadonlyArray<AttentionRow>> =>
  runP10(
    Effect.gen(function* () {
      yield* migrate;
      yield* seedCanonical(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* insertProjectRootRow(p10Root, projectId);
          yield* insertWorkspaceRow(
            { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
            projectId,
          );
          yield* insertWorkspaceRow(
            {
              workspaceId: p10Child,
              parentWorkspaceId: p10Root,
              name: "Parent",
            },
            projectId,
          );
          yield* insertWorkRow(
            {
              workId: consumerWorkId,
              workspaceId: p10Child,
              objective: "Parent waits for a future producer",
            },
            projectId,
          );
          yield* setCurrentWork(p10Child, consumerWorkId);
          yield* insertExecutionRow(
            {
              executionId: "exe_s3_parent_settled",
              workspaceId: p10Child,
              focusWorkId: consumerWorkId,
              settlement: {
                _tag: "Completed",
                result: { _tag: "CoordinationCompleted" },
              },
              settledAt: "t1",
            },
            projectId,
          );
          yield* sql.unsafe(
            "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
              dependencyId,
              projectId,
              consumerWorkId,
              JSON.stringify({ _tag: "AnyProducer" }),
              JSON.stringify({
                kind: "s3-evidence",
                requiredArtifactRoles: ["evidence"],
              }),
              dependencyRevision,
              "Unsatisfied",
              null,
              null,
              "t0",
              "t0",
            ],
          );
          yield* insertWaitRow(consumerWorkId, [
            {
              _tag: "DependencyChanged",
              dependencyId,
              observedRevision,
            },
          ]);
        }),
      );

      const deps = yield* makeP10Deps();
      const before = yield* snapshotDatabase();
      const rows = yield* deriveProjectAttention(projectId, deps.attention);
      expect(yield* snapshotDatabase()).toBe(before);
      return rows;
    }),
    makeP10App(),
  );

describe("pending S3 AnyProducer settled-wait Attention design RED", () => {
  it("surfaces a fresh settled AnyProducer wait with no producer or formation", async () => {
    const rows = await deriveAnyProducerAttention(0, 0);
    expect(
      rows.some(
        (row) =>
          row.source === "WaitingOnVacantProducer" &&
          row.severity === "Attention" &&
          row.targetWorkspaceId === p10Child &&
          row.dedupKey === `vacant-producer:${dependencyId}`,
      ),
    ).toBe(true);
  });

  it("does not surface a stale DependencyChanged WorkWait revision", async () => {
    const rows = await deriveAnyProducerAttention(1, 0);
    expect(
      rows.some(
        (row) =>
          row.source === "WaitingOnVacantProducer" &&
          row.dedupKey === `vacant-producer:${dependencyId}`,
      ),
    ).toBe(false);
  });
});
