import type { MigrationFile } from "./migrate.js";

/** FT-DG-01 OPEN-1 forward migration. This descriptor is intentionally not
 * wired into CURRENT_MIGRATIONS until the integrated cumulative prefix through
 * the already-owned 0039–0041 migrations is present and qualified. */
export const P42_PROJECT_RESOURCE_SOURCE_MIGRATION = {
  id: 42,
  name: "project_resource_source_attribution",
  requiresUserVersion: 41,
  sql: `
ALTER TABLE projects ADD COLUMN resource_source_json TEXT NOT NULL
  DEFAULT '{"_tag":"LegacyUnknown"}'
  CHECK (json_valid(resource_source_json));
UPDATE projects
   SET resource_source_json = '{"_tag":"LegacyUnknown"}';
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 41 };
