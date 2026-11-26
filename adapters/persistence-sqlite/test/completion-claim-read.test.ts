import {
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  CompletionHoldRead,
  ExecutionRepository,
  TransactionPort,
} from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
import {
  ClockLive,
  CompletionHoldReadLive,
  ExecutionRepositoryLive,
  layer,
  P7_MIGRATIONS,
  P8_MIGRATIONS,
  P12_MIGRATIONS,
  P25_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789b1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b1");
const workA = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789b1");

const makeApp = (filename = ":memory:") => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(CompletionHoldReadLive, base),
  );
  return Layer.mergeAll(infra, deps);
};

const seedProject = Effect.gen(function* () {
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
    }),
  );
});

const seedEpisodeClaim = (work: WorkId, revision: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,'workspace',?,'WorkEpisode',?,?,null,null,?,'t','Completed',?,'t')",
      [
        `exe_claim_${work}`,
        projectId,
        workspaceId,
        work,
        revision,
        sessionId,
        JSON.stringify({
          _tag: "Completed",
          result: {
            _tag: "CompletionClaimed",
            workRevision: revision,
            claimRef: "clm_test",
          },
        }),
      ],
    );
  });

const seedOtherCompleted = Effect.gen(function* () {
  const sql = yield* SqlClient;
  // A settled ConversationResponseEpisode execution must not surface as a
  // Work completion claim (non-WorkEpisode episode).
  yield* sql.unsafe(
    "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,'workspace',?,'ConversationResponseEpisode',?,0,null,null,?,'t','Completed',?,'t')",
    [
      "exe_coord",
      projectId,
      workspaceId,
      "msg_coord",
      sessionId,
      JSON.stringify({
        _tag: "Completed",
        result: { _tag: "CoordinationCompleted" },
      }),
    ],
  );
});

describe("completion-claim and hold-read faces (scheduler SQL isolation)", () => {
  it.effect(
    "returns episode-bound claims with their binding revision and skips non-Work settlements",
    () =>
      Effect.gen(function* () {
        yield* runMigrations(P25_MIGRATIONS);
        yield* seedProject;
        yield* seedEpisodeClaim(workA, 2);
        yield* seedOtherCompleted;
        const tx = yield* TransactionPort;
        const repo = yield* ExecutionRepository;
        const claims = yield* tx.transact(
          repo.listCompletionClaims(projectId, workspaceId),
        );
        expect(claims).toHaveLength(1);
        expect(claims[0]?.workId).toBe(workA);
        expect(claims[0]?.bindingWorkRevision).toBe(2);
        expect(JSON.parse(claims[0]?.settlementJson ?? "")).toMatchObject({
          result: { _tag: "CompletionClaimed", workRevision: 2 },
        });
      }).pipe(Effect.provide(makeApp())),
  );

  it.effect(
    "marks the hold faces unavailable below the P8 baseline and available from P8",
    () =>
      Effect.gen(function* () {
        const read = yield* CompletionHoldRead;
        // v1–v7: no verifications / work_acceptances tables yet.
        yield* runMigrations(P7_MIGRATIONS);
        expect(yield* read.available).toBe(false);
        // v8 creates verifications + work_acceptances.
        yield* runMigrations(P8_MIGRATIONS);
        expect(yield* read.available).toBe(true);
      }).pipe(Effect.provide(makeApp())),
  );

  it.effect("a fresh current-schema database carries the hold faces", () =>
    Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      const read = yield* CompletionHoldRead;
      expect(yield* read.available).toBe(true);
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const claims = yield* tx.transact(
        repo.listCompletionClaims(projectId, workspaceId),
      );
      expect(claims).toEqual([]);
    }).pipe(Effect.provide(makeApp())),
  );
});
