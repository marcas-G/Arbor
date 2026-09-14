import { Schema } from "effect";

/** P1_DOMAIN_CONTRACT + D-026: contains exactly these four fields.
 * It must NOT contain the Workspace Store commit SHA that contains itself. */
export const EffectiveResultSchema = Schema.Struct({
  resultId: Schema.String,
  producedByChangeId: Schema.String,
  projectCandidateCommit: Schema.String,
  verifiedByVerificationId: Schema.String,
});

export interface EffectiveResult extends Schema.Schema.Type<typeof EffectiveResultSchema> {}
