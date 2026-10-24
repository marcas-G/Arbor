import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { satisfactionCommandId } from "../packages/application/dist/index.js";
import { ProjectId, parse, WorkId } from "../packages/domain/dist/index.js";
import {
  type AttentionRow,
  deriveProjectAttention,
} from "../packages/projection-runtime/src/index.js";
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
} from "./support/p10-fixture.js";

const projectId = parse(ProjectId)(p10Project);
const consumerWorkId = parse(WorkId)(
  "wrk_00000000-0000-7000-8000-0000000000f1",
);
const dependencyId = "dep_s3_any_producer_stalled";
const deliverableId = "del_00000000-0000-7000-8000-0000000000f2";
const producerWorkId = parse(WorkId)(
  "wrk_00000000-0000-7000-8000-0000000000f2",
);

const deriveAnyProducerAttention = async (
  dependencyRevision: number,
  observedRevision: number,
  options: {
    readonly wait?: boolean;
    readonly activeExecution?: boolean;
    readonly pendingFormation?: boolean;
    readonly deliverableReceipt?:
      | "none"
      | "retryable"
      | "committed"
      | "terminal-rejected";
  } = {},
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
          if (options.activeExecution === true) {
            yield* insertExecutionRow(
              {
                executionId: "exe_s3_parent_active",
                workspaceId: p10Child,
                focusWorkId: consumerWorkId,
              },
              projectId,
            );
          }
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
          if (options.wait !== false) {
            yield* insertWaitRow(consumerWorkId, [
              {
                _tag: "DependencyChanged",
                dependencyId,
                observedRevision,
              },
            ]);
          }
          if (options.pendingFormation === true) {
            yield* sql.unsafe(
              "INSERT INTO formation_proposals (proposal_id, parent_workspace_id, proposal_json, revision, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
              ["fpr_s3_pending", p10Root, "{}", 1, "Pending", "t0", "t0"],
            );
          }
          if (options.deliverableReceipt !== undefined) {
            yield* insertWorkRow(
              {
                workId: producerWorkId,
                workspaceId: p10Child,
                objective: "completed producer source",
                lifecycle: "Completed",
              },
              projectId,
            );
            yield* sql.unsafe(
              "INSERT INTO deliverables (deliverable_id, project_id, source_work_id, source_work_revision, kind, created_at) VALUES (?,?,?,?,?,?)",
              [
                deliverableId,
                projectId,
                producerWorkId,
                0,
                "s3-evidence",
                "t0",
              ],
            );
            yield* sql.unsafe(
              "INSERT INTO deliverable_artifacts (deliverable_id, role, artifact_id) VALUES (?,?,?)",
              [deliverableId, "evidence", "art_s3_evidence"],
            );
            if (options.deliverableReceipt === "retryable") {
              const commandId = satisfactionCommandId(
                deliverableId as never,
                dependencyId as never,
                dependencyRevision as never,
              );
              yield* sql.unsafe(
                "INSERT INTO command_attempts (command_id, attempt_no, started_at, settled_at, outcome, failure_kind, metadata_json) VALUES (?,?,?,?,?,?,?)",
                [
                  commandId,
                  0,
                  "t0",
                  "t0",
                  "RetryableOperationalFailure",
                  "test-retryable",
                  null,
                ],
              );
            }
            if (
              options.deliverableReceipt === "committed" ||
              options.deliverableReceipt === "terminal-rejected"
            ) {
              const commandId = satisfactionCommandId(
                deliverableId as never,
                dependencyId as never,
                dependencyRevision as never,
              );
              yield* sql.unsafe(
                "INSERT INTO commands (command_id, project_id, semantic_request_fingerprint, schema_version, fingerprint_algorithm_version, resolution, result_json, terminal_error_json, created_at, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [
                  commandId,
                  projectId,
                  "f".repeat(64),
                  "1",
                  1,
                  options.deliverableReceipt === "committed"
                    ? "Committed"
                    : "TerminalRejected",
                  options.deliverableReceipt === "committed" ? "{}" : null,
                  options.deliverableReceipt === "terminal-rejected"
                    ? "{}"
                    : null,
                  "t0",
                  "t0",
                ],
              );
            }
          }
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

describe("S3 APW-3 settled AnyProducer Attention projection", () => {
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

  it("does not surface after the canonical WorkWait is cleared", async () => {
    const rows = await deriveAnyProducerAttention(0, 0, { wait: false });
    expect(
      rows.some((row) => row.dedupKey === `vacant-producer:${dependencyId}`),
    ).toBe(false);
  });

  it("suppresses the row while a Project Execution is active", async () => {
    const rows = await deriveAnyProducerAttention(0, 0, {
      activeExecution: true,
    });
    expect(
      rows.some((row) => row.dedupKey === `vacant-producer:${dependencyId}`),
    ).toBe(false);
  });

  it("suppresses the row for a pending formation decision", async () => {
    const rows = await deriveAnyProducerAttention(0, 0, {
      pendingFormation: true,
    });
    expect(
      rows.some((row) => row.dedupKey === `vacant-producer:${dependencyId}`),
    ).toBe(false);
  });

  it.each([
    ["none", false],
    ["retryable", false],
    ["committed", true],
    ["terminal-rejected", true],
  ] as const)(
    "applies exact satisfaction receipt status %s to a matching Deliverable",
    async (deliverableReceipt, shouldSurface) => {
      const rows = await deriveAnyProducerAttention(0, 0, {
        deliverableReceipt,
      });
      expect(
        rows.some((row) => row.dedupKey === `vacant-producer:${dependencyId}`),
      ).toBe(shouldSurface);
    },
  );
});
