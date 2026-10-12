import { createHash } from "node:crypto";
import {
  P4_TOOL_OBSERVATION_FORMAT_V1,
  type ToolObservationSettlement,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  decodeToolObservationEvidence,
  encodeToolObservationEvidence,
} from "../src/tool-observation-evidence-codec.js";

const historicalExpectedFailureEvidence = (text: string) => {
  const observation = {
    _tag: "ExpectedFailure",
    observation: { text, truncated: false },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(observation));
  const sha256 = createHash("sha256")
    .update(`${P4_TOOL_OBSERVATION_FORMAT_V1}\n`)
    .update(bytes)
    .digest("hex");
  return {
    formatVersion: P4_TOOL_OBSERVATION_FORMAT_V1,
    bytes,
    sha256,
    settlement: { _tag: "ExpectedFailure" } as const,
    resultRef: null,
  };
};

describe("P40 canonical tool observation evidence codec", () => {
  it("encodes and decodes the exact bounded evidence bytes and version-bound hash", () => {
    const input = {
      settlement: { _tag: "ExpectedFailure" } as const,
      observation: {
        _tag: "ExpectedFailure" as const,
        observation: { text: "compiler rejected input", truncated: false },
      },
      resultRef: null,
    };
    const encoded = encodeToolObservationEvidence(input);
    expect(encoded._tag).toBe("Encoded");
    if (encoded._tag !== "Encoded") return;
    expect(new TextDecoder().decode(encoded.evidence.bytes)).toBe(
      '{"_tag":"ExpectedFailure","observation":{"text":"compiler rejected input","truncated":false}}',
    );
    const decoded = decodeToolObservationEvidence({
      formatVersion: encoded.evidence.formatVersion,
      bytes: encoded.evidence.bytes,
      sha256: encoded.evidence.sha256,
      settlement: input.settlement,
      resultRef: null,
    });
    expect(decoded).toEqual({ _tag: "Decoded", evidence: encoded.evidence });
  });

  it("keeps valid bounded observations below the 16 KiB cap and rejects oversized stored bodies", () => {
    const settlement = { _tag: "ExpectedFailure" } as const;
    const empty = encodeToolObservationEvidence({
      settlement,
      observation: {
        _tag: "ExpectedFailure",
        observation: { text: "", truncated: false },
      },
      resultRef: null,
    });
    expect(empty._tag).toBe("Encoded");
    if (empty._tag !== "Encoded") return;
    const textLength = 2_000;
    const atLimit = encodeToolObservationEvidence({
      settlement,
      observation: {
        _tag: "ExpectedFailure",
        observation: { text: "x".repeat(textLength), truncated: false },
      },
      resultRef: null,
    });
    expect(atLimit._tag).toBe("Encoded");
    if (atLimit._tag !== "Encoded") return;
    expect(atLimit.evidence.bytes.byteLength).toBeLessThan(16_384);
    const overLimit = decodeToolObservationEvidence({
      formatVersion: P4_TOOL_OBSERVATION_FORMAT_V1,
      bytes: new Uint8Array(16_385),
      sha256: "0".repeat(64),
      settlement,
      resultRef: null,
    });
    expect(overLimit).toEqual({ _tag: "Failure", failureCode: "Malformed" });
  });

  it("rejects text over 2,000 UTF-16 code units on both write and historical replay", () => {
    const settlement = { _tag: "ExpectedFailure" } as const;
    const plainOverLimit = "x".repeat(2_001);
    const surrogatePairAtLimit = "😀".repeat(1_000);
    const surrogatePairsPlusUnitOverLimit = `${"😀".repeat(1_000)}x`;

    expect(surrogatePairAtLimit.length).toBe(2_000);
    expect(surrogatePairsPlusUnitOverLimit.length).toBe(2_001);
    expect(Array.from(surrogatePairsPlusUnitOverLimit)).toHaveLength(1_001);
    expect(
      encodeToolObservationEvidence({
        settlement,
        observation: {
          _tag: "ExpectedFailure",
          observation: { text: surrogatePairAtLimit, truncated: false },
        },
        resultRef: null,
      })._tag,
    ).toBe("Encoded");

    for (const text of [plainOverLimit, surrogatePairsPlusUnitOverLimit]) {
      expect(
        encodeToolObservationEvidence({
          settlement,
          observation: {
            _tag: "ExpectedFailure",
            observation: { text, truncated: false },
          },
          resultRef: null,
        }),
      ).toEqual({ _tag: "Failure", failureCode: "Malformed" });
      expect(
        decodeToolObservationEvidence(historicalExpectedFailureEvidence(text)),
      ).toEqual({ _tag: "Failure", failureCode: "Malformed" });
    }
  });

  it("fails closed for missing, unsupported, corrupt, mismatched, or unexpected refs", () => {
    const observation = {
      _tag: "ExpectedFailure" as const,
      observation: { text: "failure", truncated: false },
    };
    const encoded = encodeToolObservationEvidence({
      settlement: { _tag: "ExpectedFailure" },
      observation,
      resultRef: null,
    });
    expect(encoded._tag).toBe("Encoded");
    if (encoded._tag !== "Encoded") return;
    const base = {
      formatVersion: encoded.evidence.formatVersion,
      bytes: encoded.evidence.bytes,
      sha256: encoded.evidence.sha256,
      settlement: { _tag: "ExpectedFailure" } as ToolObservationSettlement,
      resultRef: null,
    };
    expect(
      decodeToolObservationEvidence({ ...base, formatVersion: null }),
    ).toMatchObject({ _tag: "Failure", failureCode: "Missing" });
    expect(
      decodeToolObservationEvidence({ ...base, formatVersion: "v2" }),
    ).toMatchObject({ _tag: "Failure", failureCode: "UnsupportedVersion" });
    expect(
      decodeToolObservationEvidence({
        ...base,
        sha256: `${encoded.evidence.sha256.slice(0, -1)}0`,
      }),
    ).toMatchObject({ _tag: "Failure", failureCode: "HashMismatch" });
    expect(
      decodeToolObservationEvidence({
        ...base,
        settlement: { _tag: "Success" },
      }),
    ).toMatchObject({ _tag: "Failure", failureCode: "SettlementMismatch" });
    expect(
      decodeToolObservationEvidence({ ...base, resultRef: "art_wrong" }),
    ).toMatchObject({ _tag: "Failure", failureCode: "UnexpectedResultRef" });
    expect(P4_TOOL_OBSERVATION_FORMAT_V1).toBe(
      "p4-canonical-tool-observation-v1",
    );
  });

  it("binds ReconciledNoEffect to the exact selected fact and separate P4 ArtifactRef", () => {
    const settlement: ToolObservationSettlement = {
      _tag: "ReconciledNoEffect",
      reasonCode: "StopRequested",
      reconciliationFactRef: "trf_selected_attempt_1",
    };
    const observation = {
      _tag: "ReconciledNoEffect" as const,
      reasonCode: "StopRequested" as const,
      reconciliationFactRef: "trf_selected_attempt_1",
      observation: { text: "did not run", truncated: false },
      resultRef: "art_018f2b3c-4d5e-7abc-8def-0123456789a1",
    };
    const encoded = encodeToolObservationEvidence({
      settlement,
      observation,
      resultRef: "art_018f2b3c-4d5e-7abc-8def-0123456789a1",
    });
    expect(encoded._tag).toBe("Encoded");
    expect(
      encodeToolObservationEvidence({
        settlement,
        observation: { ...observation, reconciliationFactRef: "trf_other" },
        resultRef: "art_018f2b3c-4d5e-7abc-8def-0123456789a1",
      }),
    ).toMatchObject({ _tag: "Failure", failureCode: "SettlementMismatch" });
    expect(
      encodeToolObservationEvidence({
        settlement,
        observation,
        resultRef: "art_018f2b3c-4d5e-7abc-8def-0123456789a2",
      }),
    ).toMatchObject({ _tag: "Failure", failureCode: "ResultRefMismatch" });
    expect(
      encodeToolObservationEvidence({
        settlement,
        observation: { ...observation, resultRef: "art_not-an-id" },
        resultRef: "art_not-an-id",
      }),
    ).toMatchObject({ _tag: "Failure", failureCode: "ResultRefMismatch" });
  });
});
