import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptReq, TranscriptRes } from "@arbor/api-contracts";
import { ProjectId, parse, SessionId, WorkspaceId } from "@arbor/domain";
import { ProjectionQueryPort } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  buildSliceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789b1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b1");

describe("P14 conversation history paging", () => {
  it("returns the latest chronological page, then older pages by stable cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p14-conversation-history-"));
    const databaseFile = join(dir, "history.db");
    const app = buildSliceLayer({ databaseFile, projectId });
    try {
      const pages = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(CURRENT_MIGRATIONS);
            const sql = yield* SqlClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(
                  "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  [
                    projectId,
                    "Conversation history test",
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
                    "Root",
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
                for (let index = 0; index < 5; index += 1) {
                  const minute = String(index).padStart(2, "0");
                  yield* sql.unsafe(
                    "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no) VALUES (?,?,?,?,?,?,?,'Answered',?,?,?, ?,0)",
                    [
                      `msg_${minute}`,
                      projectId,
                      workspaceId,
                      "user:test",
                      `human-${index}`,
                      `cmd_${minute}`,
                      `fingerprint-${index}`,
                      `exe_${minute}`,
                      `2026-09-25T00:${minute}:00.000Z`,
                      `2026-09-25T00:${minute}:30.000Z`,
                      `assistant-${index}`,
                    ],
                  );
                }
              }),
            );

            const query = yield* ProjectionQueryPort;
            const first = yield* query.query<TranscriptReq, TranscriptRes>(
              "transcript",
              { workspaceId, limit: 4, conversationOnly: true },
            );
            if (first.value.nextCursor === undefined) {
              throw new Error("expected a cursor for the older page");
            }
            const second = yield* query.query<TranscriptReq, TranscriptRes>(
              "transcript",
              {
                workspaceId,
                limit: 4,
                conversationOnly: true,
                cursor: first.value.nextCursor,
              },
            );
            const third = yield* query.query<TranscriptReq, TranscriptRes>(
              "transcript",
              {
                workspaceId,
                limit: 4,
                conversationOnly: true,
                cursor: second.value.nextCursor,
              },
            );
            return [first.value, second.value, third.value] as const;
          }),
          app,
        ),
      );

      const bodies = pages.flatMap((page) =>
        page.entries.map((entry) =>
          "body" in entry ? entry.body : entry.summaryRef,
        ),
      );
      expect(bodies).toEqual([
        "human-3",
        "assistant-3",
        "human-4",
        "assistant-4",
        "human-1",
        "assistant-1",
        "human-2",
        "assistant-2",
        "human-0",
        "assistant-0",
      ]);
      expect(pages[0]?.entries[0]?.kind).toBe("HumanConversationTurn");
      expect(pages[0]?.entries.at(-1)?.kind).toBe("AssistantConversationTurn");
      expect(pages[2]?.nextCursor).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
