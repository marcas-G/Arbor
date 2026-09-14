import { Schema } from "effect";
import { EffectiveResultSchema } from "./effective-result.js";
import { ResourceMappingSchema } from "./resource-mapping.js";
import { WorkspaceContractSchema } from "./workspace-contract.js";

/** P1 current effective Workspace state. Must not contain transcript,
 * Working Copy, pending Change, temporary verification, or runtime process
 * state (P1_DOMAIN_CONTRACT). */
export const WorkspaceStateSchema = Schema.Struct({
  workspaceId: Schema.String,
  projectId: Schema.String,
  contract: WorkspaceContractSchema,
  localDefinitionRef: Schema.String,
  resources: ResourceMappingSchema,
  currentEffectiveResult: Schema.optional(EffectiveResultSchema),
});

export interface WorkspaceState extends Schema.Schema.Type<typeof WorkspaceStateSchema> {}
