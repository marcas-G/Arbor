import { Schema } from "effect";

export const WorkspaceContractSchema = Schema.Struct({
  intent: Schema.String,
  responsibility: Schema.String,
  deliverables: Schema.String,
  inheritedConstraints: Schema.Array(Schema.String),
});

export interface WorkspaceContract extends Schema.Schema.Type<typeof WorkspaceContractSchema> {}
