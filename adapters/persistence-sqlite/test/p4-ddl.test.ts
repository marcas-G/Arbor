import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer, P4_MIGRATIONS, runMigrations } from "../src/index.js";

const withClient = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(Effect.provide(program, layer({ filename: ":memory:" })));

describe("P4 DDL", () => {
  it("migrates to user_version 4 with the tool-runtime tables", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P4_MIGRATIONS);
        const sql = yield* SqlClient;
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const tables = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tool_invocations','artifacts','invocation_approvals')",
        );
        return {
          version: Number(version[0]?.user_version),
          tables: tables.map((t) => t.name).sort(),
        };
      }),
    );
    expect(result.version).toBe(4);
    expect(result.tables).toEqual([
      "artifacts",
      "invocation_approvals",
      "tool_invocations",
    ]);
  });

  it("rejects an invalid SideEffectSemantics or inconsistent settlement", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P4_MIGRATIONS);
        const sql = yield* SqlClient;
        const badSemantics = yield* sql
          .unsafe(
            "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, approval_id, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,NULL,NULL,NULL)",
            ["tiv_1", "exe_x", "ws_x", "read", "1", "Bogus", "{}", "[]", "t"],
          )
          .pipe(Effect.exit);
        const badSettlement = yield* sql
          .unsafe(
            "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, approval_id, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,NULL)",
            [
              "tiv_2",
              "exe_x",
              "ws_x",
              "read",
              "1",
              "ReadOnly",
              "{}",
              "[]",
              "t",
              "t",
              "Success",
              "{}",
            ],
          )
          .pipe(Effect.exit);
        return { badSemantics, badSettlement };
      }),
    );
    expect(result.badSemantics._tag).toBe("Failure");
    expect(result.badSettlement._tag).toBe("Failure");
  });
});
