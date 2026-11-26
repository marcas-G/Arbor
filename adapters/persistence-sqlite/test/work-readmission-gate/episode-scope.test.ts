import { TransactionPort } from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  executionId,
  otherProjectId,
  otherWorkId,
  otherWorkspaceId,
  projectId,
  query,
  runDb,
  seed,
  seedOtherProjectExecution,
  seedOtherWorkspaceExecution,
  seedTerminalProviderFailureChain,
  terminalSettlement,
  workId,
  workspaceId,
} from "./support.js";

describe("P2 WorkReadmissionGateStore", () => {
  it("does not let a malformed terminal Episode for another Work in the same Workspace cross-hold", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("RequestRejected"));
        yield* seedTerminalProviderFailureChain("RequestRejected");
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          Effect.gen(function* () {
            yield* sql.unsafe(
              `INSERT INTO works (
                work_id, project_id, workspace_id, objective, why, constraints,
                completion_expectation, verification_mission, provenance,
                lifecycle, revision, created_at, updated_at
              ) VALUES (?, ?, ?, 'sibling objective', 'why', '[]', 'done', '{}', '{}', 'Open', 0, 't0', 't0')`,
              [otherWorkId, projectId, workspaceId],
            );
            yield* sql.unsafe(
              "UPDATE executions SET episode_ref = ? WHERE execution_id = ?",
              [otherWorkId, executionId],
            );
            yield* sql.unsafe(
              "UPDATE agent_execution_state SET episode_json = '{broken' WHERE execution_id = ?",
              [executionId],
            );
          }),
        );
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it("does not parse a malformed terminal non-Work Episode as a Work source", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("RequestRejected"));
        yield* seedTerminalProviderFailureChain("RequestRejected");
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          Effect.gen(function* () {
            yield* sql.unsafe(
              `UPDATE executions
                  SET episode_kind = 'ConversationResponseEpisode',
                      episode_ref = 'msg_unrelated', episode_revision = 1
                WHERE execution_id = ?`,
              [executionId],
            );
            yield* sql.unsafe(
              "UPDATE agent_execution_state SET episode_json = '{broken' WHERE execution_id = ?",
              [executionId],
            );
          }),
        );
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it("fails closed when the exact target binding has malformed Episode state", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("RequestRejected"));
        yield* seedTerminalProviderFailureChain("RequestRejected");
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE agent_execution_state SET episode_json = '{broken' WHERE execution_id = ?",
            [executionId],
          ),
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"EpisodeMalformed"',
          );
        }
      }),
    ));

  it("does not cross-hold terminal evidence from another Work revision", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("RequestRejected"));
        yield* seedTerminalProviderFailureChain("RequestRejected");
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "UPDATE executions SET episode_revision = 1 WHERE execution_id = ?",
              [executionId],
            );
            yield* sql.unsafe(
              `UPDATE agent_execution_state
                  SET episode_json = ?
                WHERE execution_id = ?`,
              [
                JSON.stringify({
                  _tag: "WorkEpisode",
                  workId,
                  targetWorkRevision: 1,
                }),
                executionId,
              ],
            );
          }),
        );
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it("does not cross-hold terminal evidence whose Execution belongs to another Workspace", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("RequestRejected"));
        yield* seedOtherWorkspaceExecution;
        yield* seedTerminalProviderFailureChain("RequestRejected");
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE executions SET workspace_id = ? WHERE execution_id = ?",
            [otherWorkspaceId, executionId],
          ),
        );
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it("does not cross-hold terminal evidence from another Project", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("RequestRejected"));
        yield* seedOtherProjectExecution;
        yield* seedTerminalProviderFailureChain("RequestRejected");
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE executions SET project_id = ? WHERE execution_id = ?",
            [otherProjectId, executionId],
          ),
        );
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it.each(["RateLimited", "ProviderUnavailable", "StreamInterrupted"] as const)(
    "holds final %s failures when the exact terminal chain is complete",
    (kind) =>
      runDb(
        Effect.gen(function* () {
          yield* seed(terminalSettlement(kind));
          yield* seedTerminalProviderFailureChain(kind);
          expect(Option.isSome(yield* query())).toBe(true);
        }),
      ),
  );
});
