import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

/**
 * Upgrade only an isolated test database whose project table predates the
 * resource-source field. Rows that existed before the test's current write
 * path are historical and therefore carry the canonical LegacyUnknown value.
 */
export const ensureLegacyProjectResourceSourceFixture = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const columns = yield* sql.unsafe<{ readonly name: string }>(
      "PRAGMA table_info(projects)",
    );
    const sourceColumnExists = columns.some(
      (column) => column.name === "resource_source_json",
    );
    if (!sourceColumnExists) {
      yield* sql.unsafe(
        "ALTER TABLE projects ADD COLUMN resource_source_json TEXT",
      );
    }
    yield* sql.unsafe(
      'UPDATE projects SET resource_source_json = \'{"_tag":"LegacyUnknown"}\' WHERE resource_source_json IS NULL',
    );
  });
