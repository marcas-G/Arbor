import { describe, expect, it } from "vitest";
import {
  canonicalizeLegacyAdoptionEvidenceV1,
  legacyAdoptionAttentionFactIdV1,
} from "../src/legacy-adoption-attention.js";
import { sha256Hex } from "../src/provider-extension.js";

describe("AH14 legacy-adoption evidence v1 codec", () => {
  it("normalizes strings and recursively orders object keys by Unicode code point", () => {
    const value = {
      "𝄞": "e\u0301",
      "": 1,
      nested: { "𝄞": 2, "": 3 },
    };
    expect(canonicalizeLegacyAdoptionEvidenceV1(value)).toBe(
      '{"nested":{"":3,"𝄞":2},"":1,"𝄞":"é"}',
    );
  });

  it("requires explicit Missing markers and integer-only numbers", () => {
    expect(
      canonicalizeLegacyAdoptionEvidenceV1({ value: { _tag: "Missing" } }),
    ).toBe('{"value":{"_tag":"Missing"}}');
    expect(() =>
      canonicalizeLegacyAdoptionEvidenceV1({ value: undefined }),
    ).toThrow();
    expect(() =>
      canonicalizeLegacyAdoptionEvidenceV1({ value: 1.5 }),
    ).toThrow();
  });

  it("derives deterministic attention ids from the canonical evidence hash", () => {
    const digest = "0123456789abcdef".repeat(4);
    expect(legacyAdoptionAttentionFactIdV1("exe", digest)).toBe(
      `att_${sha256Hex(
        `{"version":1,"executionId":"exe","evidenceSha256":"${digest}"}`,
      )}`,
    );
  });
});
