import { ProjectDirectory } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P18_MIGRATIONS,
  ProjectDirectoryLive,
  runMigrations,
} from "../src/index.js";

describe("P15 local ProjectDirectory", () => {
  it("returns canonical project rows through the port in updated order", async () => {
    const base = layer({ filename: ":memory:" });
    const services = Layer.mergeAll(
      base,
      Layer.provide(ProjectDirectoryLive, base),
    );
    const rows = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P18_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            `ALTER TABLE projects ADD COLUMN resource_source_json TEXT NOT NULL DEFAULT '{"_tag":"LegacyUnknown"}' CHECK (json_valid(resource_source_json))`,
          );
          yield* sql.unsafe("PRAGMA foreign_keys = OFF");
          yield* sql.unsafe(
            "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, resource_source_json, lifecycle, revision, created_at, updated_at) VALUES ('prj_1', 'One', 'ws_1', '{}', 0, '{}', 'local', '{\"_tag\":\"Profile\",\"resourceProfileRef\":\"repo-default\",\"version\":\"7\"}', 'Open', 2, 't1', 't2')",
          );
          return yield* (yield* ProjectDirectory).list();
        }),
        services,
      ),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        projectId: "prj_1",
        name: "One",
        lifecycle: "Open",
        revision: 2,
        resourceSource: {
          _tag: "Profile",
          resourceProfileRef: "repo-default",
          version: "7",
        },
      }),
    ]);
  });
});
