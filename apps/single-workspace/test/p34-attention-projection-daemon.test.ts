import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ProjectId, parse } from "../../../packages/domain/src/index.js";
import {
  buildSingleWorkspaceLayer,
  ProductionDaemonService,
} from "../src/index.js";

describe("P34 daemon migration wiring", () => {
  it("creates Attention projection storage through real daemon startup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-p34-daemon-"));
    const databaseFile = join(directory, "daemon.sqlite");
    const projectId = parse(ProjectId)(
      "prj_018f2b3c-4d5e-7abc-8def-0123456789ae",
    );
    try {
      const app = buildSingleWorkspaceLayer({ databaseFile, projectId });
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const daemon = yield* ProductionDaemonService;
              yield* daemon.daemon.start;
              const sql = yield* SqlClient;
              const version = yield* sql.unsafe<{
                user_version: number;
              }>("PRAGMA user_version");
              const tables = yield* sql.unsafe<{ name: string }>(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name IN (
                      'assign_work_target_bindings',
                      'assign_work_binding_attention_facts',
                      'attention_projection_rows'
                    )
                  ORDER BY name`,
              );
              return {
                version: Number(version[0]?.user_version ?? 0),
                tables: tables.map((row) => row.name),
              };
            }),
            app,
          ),
        ),
      );
      expect(result).toEqual({
        version: 34,
        tables: [
          "assign_work_binding_attention_facts",
          "assign_work_target_bindings",
          "attention_projection_rows",
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
