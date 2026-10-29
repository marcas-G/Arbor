import { createHash, createPublicKey, verify } from "node:crypto";
import {
  decodeCanonicalBase64V1,
  decodeCanonicalWindowsNativeManifestSignatureV1,
  type WindowsNativeOperatorTrustSetV1,
} from "@arbor/domain";

const domain = Buffer.from(
  "Arbor.WindowsNativeQualificationManifestV1\0",
  "ascii",
);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const canonicalUtc = (now: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(now) &&
  Number.isFinite(Date.parse(now)) &&
  new Date(Date.parse(now)).toISOString() === now;

export type WindowsNativeOperatorProvenanceResult =
  | { readonly _tag: "Verified"; readonly keyId: string }
  | {
      readonly _tag: "Unavailable";
      readonly reason:
        | "TrustCurrentnessMismatch"
        | "TrustKeyUnavailable"
        | "TrustKeyRevoked"
        | "TrustKeyExpired"
        | "SignatureInvalid";
    };

/** Only the current protected V3 source supplies the trust set. This
 * primitive never accepts a manifest-supplied key, mtime or unsigned time. */
export const verifyWindowsNativeOperatorProvenanceV1 = (input: {
  readonly trustSet: WindowsNativeOperatorTrustSetV1;
  readonly manifestBytes: Uint8Array;
  readonly sidecarBytes: Uint8Array;
  readonly now: string;
}): WindowsNativeOperatorProvenanceResult => {
  const unavailable = (
    reason: Extract<
      WindowsNativeOperatorProvenanceResult,
      { readonly _tag: "Unavailable" }
    >["reason"],
  ): WindowsNativeOperatorProvenanceResult => ({ _tag: "Unavailable", reason });
  try {
    if (!canonicalUtc(input.now))
      return unavailable("TrustCurrentnessMismatch");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      input.sidecarBytes,
    );
    if (!Buffer.from(text, "utf8").equals(input.sidecarBytes))
      return unavailable("SignatureInvalid");
    const sidecar = decodeCanonicalWindowsNativeManifestSignatureV1(text);
    if (sidecar === undefined) return unavailable("SignatureInvalid");
    const trust = input.trustSet;
    if (trust.providerId !== "windows-restricted-appcontainer-job")
      return unavailable("TrustKeyUnavailable");
    const key = trust.keys.find(
      (candidate) => candidate.keyId === sidecar.keyId,
    );
    if (key === undefined) return unavailable("TrustKeyUnavailable");
    if (trust.revokedKeyIds.includes(key.keyId))
      return unavailable("TrustKeyRevoked");
    // Retiring is intentionally all-reject: the three-field sidecar cannot
    // prove that an older signature predates retirement.
    if (key.status !== "Active") return unavailable("TrustKeyUnavailable");
    if (input.now < key.validFrom || input.now >= key.validUntil)
      return unavailable("TrustKeyExpired");
    const spki = decodeCanonicalBase64V1(key.publicKeySpkiDerBase64);
    const signature = decodeCanonicalBase64V1(sidecar.signatureBase64);
    if (
      spki?.length !== 44 ||
      signature?.length !== 64 ||
      sha256(spki) !== key.publicKeySpkiSha256
    )
      return unavailable("SignatureInvalid");
    const publicKey = createPublicKey({
      key: Buffer.from(spki),
      format: "der",
      type: "spki",
    });
    const message = Buffer.concat([domain, Buffer.from(input.manifestBytes)]);
    return verify(null, message, publicKey, Buffer.from(signature))
      ? { _tag: "Verified", keyId: key.keyId }
      : unavailable("SignatureInvalid");
  } catch {
    return unavailable("SignatureInvalid");
  }
};
