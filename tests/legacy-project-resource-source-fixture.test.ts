import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  layer,
  ProjectRepositoryLive,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { ProjectId, parse } from "../packages/domain/dist/index.js";
import {
  ProjectRepository,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "./support/legacy-project-resource-source.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ac");

describe("legacy Project resource-source test fixture", () => {
  it("backfills only NULL values and preserves strict decoding of invalid values", async () => {
    const base = layer({ filename: ":memory:" });
    const infra = Layer.mergeAll(base, ClockLive);
    const app = Layer.mergeAll(
      infra,
      Layer.provide(ProjectRepositoryLive, infra),
      Layer.provide(TransactionPortLive, infra),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(`
            CREATE TABLE projects (
              project_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              root_workspace_id TEXT NOT NULL,
              project_policy TEXT NOT NULL,
              project_policy_revision INTEGER NOT NULL,
              default_configuration TEXT NOT NULL,
              environment_ref TEXT NOT NULL,
              lifecycle TEXT NOT NULL,
              revision INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
          `);
          yield* ensureLegacyProjectResourceSourceFixture();
          yield* sql.unsafe(
            "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, resource_source_json, lifecycle, revision, created_at, updated_at) VALUES (?, 'fixture', 'ws_fixture', '{}', 0, '{}', 'local', NULL, 'Open', 0, 't', 't')",
            [projectId],
          );
          yield* ensureLegacyProjectResourceSourceFixture();
          const legacyRows = yield* sql.unsafe<{
            resource_source_json: string;
          }>("SELECT resource_source_json FROM projects WHERE project_id = ?", [
            projectId,
          ]);

          const profileSource = JSON.stringify({
            _tag: "Profile",
            resourceProfileRef: "profile:fixture",
            version: "v7",
          });
          yield* sql.unsafe(
            "UPDATE projects SET resource_source_json = ? WHERE project_id = ?",
            [profileSource, projectId],
          );
          yield* ensureLegacyProjectResourceSourceFixture();
          const profileRows = yield* sql.unsafe<{
            resource_source_json: string;
          }>("SELECT resource_source_json FROM projects WHERE project_id = ?", [
            projectId,
          ]);

          const invalidSource = '{"_tag":"Profile"}';
          yield* sql.unsafe(
            "UPDATE projects SET resource_source_json = ? WHERE project_id = ?",
            [invalidSource, projectId],
          );
          yield* ensureLegacyProjectResourceSourceFixture();
          const invalidRows = yield* sql.unsafe<{
            resource_source_json: string;
          }>("SELECT resource_source_json FROM projects WHERE project_id = ?", [
            projectId,
          ]);
          const projects = yield* ProjectRepository;
          const transaction = yield* TransactionPort;
          const invalidRead = yield* transaction.transact(
            Effect.exit(projects.findById(projectId)),
          );

          return {
            legacySource: legacyRows[0]?.resource_source_json,
            profileSource: profileRows[0]?.resource_source_json,
            invalidSource: invalidRows[0]?.resource_source_json,
            invalidRead,
          };
        }),
        app,
      ),
    );

    expect(result.legacySource).toBe('{"_tag":"LegacyUnknown"}');
    expect(result.profileSource).toBe(
      '{"_tag":"Profile","resourceProfileRef":"profile:fixture","version":"v7"}',
    );
    expect(result.invalidSource).toBe('{"_tag":"Profile"}');
    expect(Exit.isFailure(result.invalidRead)).toBe(true);
  });
});
