import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P20_MIGRATIONS,
  P21_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const insertMessage = (
  messageId: string,
  state: "Pending" | "Claimed" | "Answered",
  executionId: string | null,
  responseBody: string | null,
  attemptNo: number,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no, provider_reasoning_json) VALUES (?,?,?,?,?,?,?,?,?,? ,?,?,?,NULL)",
      [
        messageId,
        "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
        "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
        "user:test",
        `body:${messageId}`,
        `cmd:${messageId}`,
        `fp:${messageId}`,
        state,
        executionId,
        "2026-10-01T00:00:00.000Z",
        state === "Answered" ? "2026-10-01T00:01:00.000Z" : null,
        responseBody,
        attemptNo,
      ],
    );
  });

describe("P17 migration 0021 conversation response runtime", () => {
  it("backfills legacy messages into durable jobs and attempts re-entrantly", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P20_MIGRATIONS);
      yield* insertMessage(
        "msg_018f2b3c-4d5e-7abc-8def-0123456789a1",
        "Pending",
        null,
        null,
        2,
      );
      yield* insertMessage(
        "msg_018f2b3c-4d5e-7abc-8def-0123456789a2",
        "Claimed",
        "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
        null,
        1,
      );
      yield* insertMessage(
        "msg_018f2b3c-4d5e-7abc-8def-0123456789a3",
        "Answered",
        "exe_018f2b3c-4d5e-7abc-8def-0123456789a3",
        "answer",
        0,
      );

      const first = yield* runMigrations(P21_MIGRATIONS);
      const second = yield* runMigrations(P21_MIGRATIONS);
      const sql = yield* SqlClient;
      const version = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const jobs = yield* sql.unsafe<{
        message_id: string;
        state: string;
        active_execution_id: string | null;
        next_attempt_no: number;
        response_body: string | null;
      }>(
        "SELECT message_id, state, active_execution_id, next_attempt_no, response_body FROM conversation_response_jobs ORDER BY message_id",
      );
      const attempts = yield* sql.unsafe<{
        message_id: string;
        attempt_no: number;
        execution_id: string;
      }>(
        "SELECT message_id, attempt_no, execution_id FROM conversation_attempts ORDER BY message_id",
      );
      const breakerColumns = yield* sql.unsafe<{ name: string }>(
        "PRAGMA table_info(provider_deployment_breakers)",
      );
      return {
        first,
        second,
        version: Number(version[0]?.user_version),
        jobs,
        attempts,
        breakerColumns: breakerColumns.map((column) => column.name),
      };
    });

    const result = await Effect.runPromise(
      Effect.provide(program, layer({ filename: ":memory:" })),
    );
    expect(result.first).toBe(1);
    expect(result.second).toBe(0);
    expect(result.version).toBe(21);
    expect(result.jobs).toEqual([
      {
        message_id: "msg_018f2b3c-4d5e-7abc-8def-0123456789a1",
        state: "Queued",
        active_execution_id: null,
        next_attempt_no: 2,
        response_body: null,
      },
      {
        message_id: "msg_018f2b3c-4d5e-7abc-8def-0123456789a2",
        state: "Running",
        active_execution_id: "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
        next_attempt_no: 2,
        response_body: null,
      },
      {
        message_id: "msg_018f2b3c-4d5e-7abc-8def-0123456789a3",
        state: "Answered",
        active_execution_id: null,
        next_attempt_no: 1,
        response_body: "answer",
      },
    ]);
    expect(result.attempts).toEqual([
      {
        message_id: "msg_018f2b3c-4d5e-7abc-8def-0123456789a2",
        attempt_no: 1,
        execution_id: "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
      },
      {
        message_id: "msg_018f2b3c-4d5e-7abc-8def-0123456789a3",
        attempt_no: 0,
        execution_id: "exe_018f2b3c-4d5e-7abc-8def-0123456789a3",
      },
    ]);
    expect(result.breakerColumns).toEqual(
      expect.arrayContaining([
        "binding_fingerprint",
        "state",
        "cooldown_until",
        "revision",
      ]),
    );
  });
});
