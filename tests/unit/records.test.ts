import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EffectiveResultSchema } from "../../src/domain/effective-result.js";
import { ImplementationChangeSchema } from "../../src/domain/implementation-change.js";
import { LocalVerificationSchema } from "../../src/domain/local-verification.js";

const dec = <A, I, R>(s: Schema.Schema<A, I, R>) => Schema.decodeUnknownSync(s);
const uuid = () => crypto.randomUUID();
const sha = () => "a".repeat(40);

describe("EffectiveResult (P1_DOMAIN_CONTRACT + D-026)", () => {
  const valid = () => ({
    resultId: uuid(),
    producedByChangeId: uuid(),
    projectCandidateCommit: sha(),
    verifiedByVerificationId: uuid(),
  });

  it("round-trips", () => {
    const v = valid();
    expect(dec(EffectiveResultSchema)(v)).toEqual(v);
  });

  it("missing any field is rejected", () => {
    const v = valid() as Record<string, unknown>;
    for (const k of Object.keys(v)) {
      const bad = { ...v };
      delete bad[k];
      expect(() => dec(EffectiveResultSchema)(bad)).toThrow();
    }
  });

  it("decoded keys are exactly the four defined fields (no store SHA)", () => {
    const d = dec(EffectiveResultSchema)(valid()) as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(
      [
        "producedByChangeId",
        "projectCandidateCommit",
        "resultId",
        "verifiedByVerificationId",
      ].sort(),
    );
  });
});

describe("ImplementationChange (minimal P1 flow)", () => {
  it("round-trips with base result optional", () => {
    const withBase = { changeId: uuid(), baseEffectiveResultId: uuid() };
    expect(dec(ImplementationChangeSchema)(withBase)).toEqual(withBase);
    const first = { changeId: uuid() };
    expect(dec(ImplementationChangeSchema)(first)).toEqual(first);
  });
});

describe("LocalVerification outcomes", () => {
  it("accepts exactly PASS/FAIL/INCONCLUSIVE", () => {
    for (const outcome of ["PASS", "FAIL", "INCONCLUSIVE"] as const) {
      expect(dec(LocalVerificationSchema)({ verificationId: uuid(), outcome })).toEqual({
        verificationId: expect.any(String),
        outcome,
      });
    }
  });

  it("rejects other spellings and values", () => {
    for (const outcome of ["pass", "MAYBE", "", "FAILED"]) {
      expect(() => dec(LocalVerificationSchema)({ verificationId: uuid(), outcome })).toThrow();
    }
  });
});
