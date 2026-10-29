import type { MigrationFile } from "./migrate.js";

/** FT-DG-01 OPEN-1 forward migration. Runtime registration follows the
 * accepted P38→P39 maintenance→P40→P41 prefix and requires version 41. */
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
