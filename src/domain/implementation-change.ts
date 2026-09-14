import { Schema } from "effect";

/** Minimal Implementation Change record needed for the P1 Working → Effective flow. */
export const ImplementationChangeSchema = Schema.Struct({
  changeId: Schema.String,
  baseEffectiveResultId: Schema.optional(Schema.String),
});

export interface ImplementationChange
  extends Schema.Schema.Type<typeof ImplementationChangeSchema> {}
