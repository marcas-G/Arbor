import { Schema } from "effect";

/** FAIL = verification established non-compliance.
 * INCONCLUSIVE = the verification process itself could not form a valid judgment.
 * INCONCLUSIVE must never be silently converted to FAIL. */
export const VerificationOutcomeSchema = Schema.Literals(["PASS", "FAIL", "INCONCLUSIVE"]);

export const LocalVerificationSchema = Schema.Struct({
  verificationId: Schema.String,
  outcome: VerificationOutcomeSchema,
});

export interface LocalVerification extends Schema.Schema.Type<typeof LocalVerificationSchema> {}
