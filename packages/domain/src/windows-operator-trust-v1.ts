import { compareUtf8BytesV1 } from "./sandbox-policy-producers.js";

export interface WindowsNativeOperatorKeyV1 {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly publicKeySpkiDerBase64: string;
  readonly publicKeySpkiSha256: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly status: "Active" | "Retiring";
}

export interface WindowsNativeOperatorTrustSetV1 {
  readonly version: 1;
  readonly revision: number;
  readonly sourceIdentity: string;
  readonly providerId: "windows-restricted-appcontainer-job";
  readonly keys: ReadonlyArray<WindowsNativeOperatorKeyV1>;
  readonly revokedKeyIds: ReadonlyArray<string>;
}

export interface WindowsNativeManifestSignatureV1 {
  readonly version: 1;
  readonly keyId: string;
  readonly signatureBase64: string;
}

export type Sha256BytesHex = (bytes: Uint8Array) => string;

const exactKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const keyId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9._-]{0,95}$/u.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const sourceIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const sortedUnique = (values: ReadonlyArray<string>) =>
  values.every(
    (value, index) =>
      index === 0 || compareUtf8BytesV1(values[index - 1] ?? "", value) < 0,
  );

/** Strict padded RFC 4648 base64. A decode/re-encode equality check rejects
 * alternate spellings, whitespace, URL alphabet and nonzero pad bits. */
export const decodeCanonicalBase64V1 = (
  text: unknown,
): Uint8Array | undefined => {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      text,
    )
  )
    return undefined;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output: number[] = [];
  for (let index = 0; index < text.length; index += 4) {
    const quartet = text.slice(index, index + 4);
    const a = alphabet.indexOf(quartet[0] ?? "");
    const b = alphabet.indexOf(quartet[1] ?? "");
    const c = quartet[2] === "=" ? 0 : alphabet.indexOf(quartet[2] ?? "");
    const d = quartet[3] === "=" ? 0 : alphabet.indexOf(quartet[3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) return undefined;
    if (quartet[2] === "=" && ((b & 0x0f) !== 0 || quartet[3] !== "="))
      return undefined;
    if (quartet[3] === "=" && quartet[2] !== "=" && (c & 0x03) !== 0)
      return undefined;
    output.push((a << 2) | (b >> 4));
    if (quartet[2] !== "=") output.push(((b & 0x0f) << 4) | (c >> 2));
    if (quartet[3] !== "=") output.push(((c & 0x03) << 6) | d);
  }
  return Uint8Array.from(output);
};

// RFC 8410, AlgorithmIdentifier id-Ed25519 with absent parameters and a
// BIT STRING containing exactly 32 public-key bytes.
const ed25519SpkiPrefix = [
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
] as const;

export const encodeWindowsNativeOperatorTrustSetV1 = (
  trust: WindowsNativeOperatorTrustSetV1,
): string =>
  `{"version":1,"revision":${trust.revision},"sourceIdentity":${JSON.stringify(trust.sourceIdentity)},"providerId":"windows-restricted-appcontainer-job","keys":[${trust.keys.map((key) => `{"keyId":${JSON.stringify(key.keyId)},"algorithm":"Ed25519","publicKeySpkiDerBase64":${JSON.stringify(key.publicKeySpkiDerBase64)},"publicKeySpkiSha256":${JSON.stringify(key.publicKeySpkiSha256)},"validFrom":${JSON.stringify(key.validFrom)},"validUntil":${JSON.stringify(key.validUntil)},"status":${JSON.stringify(key.status)}}`).join(",")}],"revokedKeyIds":[${trust.revokedKeyIds.map((id) => JSON.stringify(id)).join(",")}]}`;

export const decodeCanonicalWindowsNativeOperatorTrustSetV1 = (
  json: string,
  sha256BytesHex: Sha256BytesHex,
): WindowsNativeOperatorTrustSetV1 | undefined => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    const row = parsed as Record<string, unknown>;
    if (
      !exactKeys(row, [
        "version",
        "revision",
        "sourceIdentity",
        "providerId",
        "keys",
        "revokedKeyIds",
      ]) ||
      row.version !== 1 ||
      !revision(row.revision) ||
      !sourceIdentity(row.sourceIdentity) ||
      row.providerId !== "windows-restricted-appcontainer-job" ||
      !Array.isArray(row.keys) ||
      row.keys.length === 0 ||
      !Array.isArray(row.revokedKeyIds)
    )
      return undefined;
    const keys: WindowsNativeOperatorKeyV1[] = [];
    const spkiHashes = new Set<string>();
    for (const raw of row.keys) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return undefined;
      const key = raw as Record<string, unknown>;
      if (
        !exactKeys(key, [
          "keyId",
          "algorithm",
          "publicKeySpkiDerBase64",
          "publicKeySpkiSha256",
          "validFrom",
          "validUntil",
          "status",
        ]) ||
        !keyId(key.keyId) ||
        key.algorithm !== "Ed25519" ||
        !digest(key.publicKeySpkiSha256) ||
        !instant(key.validFrom) ||
        !instant(key.validUntil) ||
        key.validFrom >= key.validUntil ||
        (key.status !== "Active" && key.status !== "Retiring")
      )
        return undefined;
      const spki = decodeCanonicalBase64V1(key.publicKeySpkiDerBase64);
      if (
        spki?.length !== 44 ||
        !ed25519SpkiPrefix.every((byte, index) => spki[index] === byte) ||
        sha256BytesHex(spki) !== key.publicKeySpkiSha256 ||
        spkiHashes.has(key.publicKeySpkiSha256)
      )
        return undefined;
      spkiHashes.add(key.publicKeySpkiSha256);
      keys.push(key as unknown as WindowsNativeOperatorKeyV1);
    }
    const ids = keys.map((key) => key.keyId);
    if (!sortedUnique(ids)) return undefined;
    const revoked = row.revokedKeyIds;
    if (
      !revoked.every(keyId) ||
      !sortedUnique(revoked) ||
      !revoked.every((id) => ids.includes(id))
    )
      return undefined;
    // More than one non-revoked Active key would make signer choice ambiguous.
    if (
      keys.filter(
        (key) => key.status === "Active" && !revoked.includes(key.keyId),
      ).length > 1
    )
      return undefined;
    const trust: WindowsNativeOperatorTrustSetV1 = {
      version: 1,
      revision: row.revision,
      sourceIdentity: row.sourceIdentity,
      providerId: "windows-restricted-appcontainer-job",
      keys,
      revokedKeyIds: revoked,
    };
    return encodeWindowsNativeOperatorTrustSetV1(trust) === json
      ? trust
      : undefined;
  } catch {
    return undefined;
  }
};

export const encodeWindowsNativeManifestSignatureV1 = (
  sidecar: WindowsNativeManifestSignatureV1,
): string =>
  `{"version":1,"keyId":${JSON.stringify(sidecar.keyId)},"signatureBase64":${JSON.stringify(sidecar.signatureBase64)}}`;

export const decodeCanonicalWindowsNativeManifestSignatureV1 = (
  json: string,
): WindowsNativeManifestSignatureV1 | undefined => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    const row = parsed as Record<string, unknown>;
    if (
      !exactKeys(row, ["version", "keyId", "signatureBase64"]) ||
      row.version !== 1 ||
      !keyId(row.keyId) ||
      decodeCanonicalBase64V1(row.signatureBase64)?.length !== 64
    )
      return undefined;
    const sidecar = row as unknown as WindowsNativeManifestSignatureV1;
    return encodeWindowsNativeManifestSignatureV1(sidecar) === json
      ? sidecar
      : undefined;
  } catch {
    return undefined;
  }
};
