import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalBase64V1,
  decodeCanonicalWindowsNativeManifestSignatureV1,
  decodeCanonicalWindowsNativeOperatorTrustSetV1,
  encodeWindowsNativeManifestSignatureV1,
  encodeWindowsNativeOperatorTrustSetV1,
} from "../src/index.js";

const hashBytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hashText = (text: string) => hashBytes(Buffer.from(text, "utf8"));
const trust =
  '{"version":1,"revision":1,"sourceIdentity":"host:test","providerId":"windows-restricted-appcontainer-job","keys":[{"keyId":"operator-2026-a","algorithm":"Ed25519","publicKeySpkiDerBase64":"MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","publicKeySpkiSha256":"06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9","validFrom":"2026-10-20T00:00:00.000Z","validUntil":"2027-10-20T00:00:00.000Z","status":"Active"}],"revokedKeyIds":[]}';
const sidecar =
  '{"version":1,"keyId":"operator-2026-a","signatureBase64":"hTMSP5sS7dGBuJiY/okX6bv5JiEURnebjrIiBX6snDnc55i85SZWuWCMnMdYM8f2PsWf3Vlefmy9GfzrDUiKBg=="}';

describe("Windows D2 V3 trust and sidecar physical codecs", () => {
  it("pins exact accepted canonical byte KATs", () => {
    const decoded = decodeCanonicalWindowsNativeOperatorTrustSetV1(
      trust,
      hashBytes,
    );
    expect(decoded).toBeDefined();
    if (decoded === undefined) throw new Error("trust KAT rejected");
    expect(encodeWindowsNativeOperatorTrustSetV1(decoded)).toBe(trust);
    expect(hashText(trust)).toBe(
      "be159a9cfea6d65bf27b6645f94bbe12efa65b7d7ffe513d53477ed48241ea4d",
    );
    const signature = decodeCanonicalWindowsNativeManifestSignatureV1(sidecar);
    expect(signature).toBeDefined();
    if (signature === undefined) throw new Error("sidecar KAT rejected");
    expect(encodeWindowsNativeManifestSignatureV1(signature)).toBe(sidecar);
    expect(hashText(sidecar)).toBe(
      "b705caabef17937aa3606ea4fbaa14be3e8670bb3c9955337e57cd6817fe6977",
    );
  });

  it("rejects noncanonical trust bytes and ambiguous signing keys", () => {
    const parsed = JSON.parse(trust);
    expect(
      decodeCanonicalWindowsNativeOperatorTrustSetV1(`${trust}\n`, hashBytes),
    ).toBeUndefined();
    expect(
      decodeCanonicalWindowsNativeOperatorTrustSetV1(
        `\uFEFF${trust}`,
        hashBytes,
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalWindowsNativeOperatorTrustSetV1(
        trust.replace('"revision":1,', '"revision":1,"revision":1,'),
        hashBytes,
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalWindowsNativeOperatorTrustSetV1(
        JSON.stringify({ ...parsed, extra: 1 }),
        hashBytes,
      ),
    ).toBeUndefined();
    parsed.keys[0].status = "Retiring";
    parsed.keys.push({
      ...parsed.keys[0],
      keyId: "operator-2026-b",
      status: "Active",
    });
    expect(
      decodeCanonicalWindowsNativeOperatorTrustSetV1(
        JSON.stringify(parsed),
        hashBytes,
      ),
    ).toBeUndefined();
  });

  it("rejects alternate base64, SPKI and sidecar encodings", () => {
    expect(decodeCanonicalBase64V1("AQ==")?.[0]).toBe(1);
    expect(decodeCanonicalBase64V1("AR==")).toBeUndefined();
    expect(decodeCanonicalBase64V1("AQ=")).toBeUndefined();
    expect(
      decodeCanonicalWindowsNativeManifestSignatureV1(`${sidecar} `),
    ).toBeUndefined();
    expect(
      decodeCanonicalWindowsNativeManifestSignatureV1(
        sidecar.replace('"version":1,', '"keyId":"x","version":1,'),
      ),
    ).toBeUndefined();
    const parsed = JSON.parse(trust);
    parsed.keys[0].publicKeySpkiDerBase64 =
      parsed.keys[0].publicKeySpkiDerBase64.replace("MCow", "MCoA");
    expect(
      decodeCanonicalWindowsNativeOperatorTrustSetV1(
        JSON.stringify(parsed),
        hashBytes,
      ),
    ).toBeUndefined();
  });
});
