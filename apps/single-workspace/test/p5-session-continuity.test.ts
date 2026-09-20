import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandGateway,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import type { AdmitExecutionPayload } from "@arbor/execution-runtime";
import { SessionRepository, TransactionPort } from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { buildSliceLayer, P4_MIGRATIONS, runMigrations } from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const execution1 = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;
const execution2 = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
) as ExecutionId;
const principal = parse(Principal)("runtime:system");
const actor = parse(Actor)("user:test");
const context: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};

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
    }),
  );
});

const admit = (executionId: ExecutionId, commandId: CommandId) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const payload: AdmitExecutionPayload = {
      _tag: "WorkspaceMain",
      executionId,
      workspaceId,
      focus: { _tag: "Coordination" },
    };
    const authority: VerifiedRuntimeCommandAuthority = {
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "System",
      principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AdmitExecution",
        projectId,
        actor,
        schemaVersion: "1",
        payload,
      }),
      projectId,
      commandKind: "AdmitExecution",
      workspaceId,
      bindingKind: "WorkspaceMain",
    };
    return yield* gateway.execute(
      {
        commandType: "AdmitExecution",
        commandId,
        projectId,
        actor,
        issuedAt: "t",
        payload,
      },
      context,
      authority,
    );
  });

describe("P5 multi-turn session continuity", () => {
  it("reuses the same primary session across Executions and keeps entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p5-sc-"));
    const app = buildSliceLayer({ databaseFile: join(dir, "slice.db") });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P4_MIGRATIONS);
          yield* seed;
          const first = yield* admit(
            execution1,
            parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1"),
          );
          const tx = yield* TransactionPort;
          const sessions = yield* SessionRepository;
          yield* tx.transact(
            sessions.appendEntry(sessionId, {
              entryKind: "Input",
              payload: { x: 1 },
            }),
          );
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            "UPDATE executions SET settlement_kind = 'Interrupted', settlement_json = '{}', settled_at = 't' WHERE execution_id = ?",
            [execution1],
          );
          const second = yield* admit(
            execution2,
            parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a2"),
          );
          const rows = yield* sql.unsafe<{ session_id: string }>(
            "SELECT session_id FROM executions ORDER BY execution_id",
          );
          const entries = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
            [sessionId],
          );
          return {
            first,
            second,
            sessions: rows.map((r) => r.session_id),
            entries: Number(entries[0]?.count ?? 0),
          };
        }),
        app,
      ) as unknown as Effect.Effect<
        {
          first: { resolution: { _tag: string } };
          second: { resolution: { _tag: string } };
          sessions: ReadonlyArray<string>;
          entries: number;
        },
        unknown,
        never
      >,
    );
    expect(result.first.resolution._tag).toBe("Committed");
    expect(result.second.resolution._tag).toBe("Committed");
    expect(new Set(result.sessions)).toEqual(new Set([sessionId]));
    expect(result.entries).toBe(1);
    void Option;
  });
});
