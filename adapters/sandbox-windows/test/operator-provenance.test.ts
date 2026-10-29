import { createHash } from "node:crypto";
import { decodeCanonicalWindowsNativeOperatorTrustSetV1 } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { verifyWindowsNativeOperatorProvenanceV1 } from "../src/operator-provenance.js";

const trustJson =
  '{"version":1,"revision":1,"sourceIdentity":"host:test","providerId":"windows-restricted-appcontainer-job","keys":[{"keyId":"operator-2026-a","algorithm":"Ed25519","publicKeySpkiDerBase64":"MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","publicKeySpkiSha256":"06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9","validFrom":"2026-10-20T00:00:00.000Z","validUntil":"2027-10-20T00:00:00.000Z","status":"Active"}],"revokedKeyIds":[]}';
const sidecarJson =
  '{"version":1,"keyId":"operator-2026-a","signatureBase64":"hTMSP5sS7dGBuJiY/okX6bv5JiEURnebjrIiBX6snDnc55i85SZWuWCMnMdYM8f2PsWf3Vlefmy9GfzrDUiKBg=="}';
const trust = decodeCanonicalWindowsNativeOperatorTrustSetV1(
  trustJson,
  (bytes) => createHash("sha256").update(bytes).digest("hex"),
);
if (trust === undefined) throw new Error("accepted trust KAT rejected");
const testKey = trust.keys[0];
if (testKey === undefined) throw new Error("accepted trust KAT lacks key");
const base = {
  trustSet: trust,
  manifestBytes: Buffer.from("{}", "utf8"),
  sidecarBytes: Buffer.from(sidecarJson, "utf8"),
  now: "2026-10-20T00:00:00.000Z",
};

describe("Windows D2 Ed25519 operator provenance", () => {
  it("verifies exact domain-separated RFC 8032 primitive KAT", () => {
    expect(verifyWindowsNativeOperatorProvenanceV1(base)).toEqual({
      _tag: "Verified",
      keyId: "operator-2026-a",
    });
  });

  it("rejects altered bytes, unavailable time, Retiring and revocation", () => {
    expect(
      verifyWindowsNativeOperatorProvenanceV1({
        ...base,
        manifestBytes: Buffer.from("{ }"),
      }),
    ).toEqual({ _tag: "Unavailable", reason: "SignatureInvalid" });
    expect(
      verifyWindowsNativeOperatorProvenanceV1({
        ...base,
        now: "2026-10-20T00:00:00Z",
      }),
    ).toEqual({ _tag: "Unavailable", reason: "TrustCurrentnessMismatch" });
    expect(
      verifyWindowsNativeOperatorProvenanceV1({
        ...base,
        now: "2027-10-20T00:00:00.000Z",
      }),
    ).toEqual({ _tag: "Unavailable", reason: "TrustKeyExpired" });
    expect(
      verifyWindowsNativeOperatorProvenanceV1({
        ...base,
        trustSet: { ...trust, keys: [{ ...testKey, status: "Retiring" }] },
      }),
    ).toEqual({ _tag: "Unavailable", reason: "TrustKeyUnavailable" });
    expect(
      verifyWindowsNativeOperatorProvenanceV1({
        ...base,
        trustSet: { ...trust, revokedKeyIds: ["operator-2026-a"] },
      }),
    ).toEqual({ _tag: "Unavailable", reason: "TrustKeyRevoked" });
  });
});
