import { Schema } from "effect";

/** Minimal Runtime Project identity required to bind source repo,
 * Root Workspace, and ARBOR_HOME project state (P1_DOMAIN_CONTRACT). */
export const ProjectSchema = Schema.Struct({
  projectId: Schema.String,
  sourceRepoPath: Schema.String,
});

export interface Project extends Schema.Schema.Type<typeof ProjectSchema> {}
