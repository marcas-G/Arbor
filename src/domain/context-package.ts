import { Schema } from "effect";
import { ResourceMappingSchema } from "./resource-mapping.js";
import { WorkspaceContractSchema } from "./workspace-contract.js";

/** P1-04A (D-034): structured projection value derived from formal Workspace
 * state. Rendered into the system prompt by a fixed template; never enters
 * the message stream. `effective.result` is deferred to P1-08. */
export const ContextPackageSchema = Schema.Struct({
  projectId: Schema.String,
  workspaceId: Schema.String,
  contract: WorkspaceContractSchema,
  resources: ResourceMappingSchema,
  worktreeRoot: Schema.String,
  effective: Schema.Struct({
    storeCommitSha: Schema.String,
  }),
});

export interface ContextPackage extends Schema.Schema.Type<typeof ContextPackageSchema> {}
