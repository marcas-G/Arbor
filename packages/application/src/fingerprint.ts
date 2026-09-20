import { createHash } from "node:crypto";
import type { SemanticRequestFingerprint } from "@arbor/domain";

export const FINGERPRINT_ALGORITHM_VERSION = 1;

export interface FingerprintInput {
  readonly commandType: string;
  readonly projectId: string;
  readonly actor: string;
  readonly schemaVersion: string;
  readonly payload: unknown;
}

const canonicalize = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("fingerprint: non-finite number");
      }
      return JSON.stringify(value);
    case "undefined":
      throw new Error("fingerprint: undefined is not serializable");
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((entry) => (entry === undefined ? "null" : canonicalize(entry)))
          .join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
        .join(",")}}`;
    }
    default:
      throw new Error(`fingerprint: unsupported value ${typeof value}`);
  }
};

export const canonicalFingerprintInput = (input: FingerprintInput): string =>
  canonicalize({
    commandType: input.commandType,
    projectId: input.projectId,
    actor: input.actor,
    schemaVersion: input.schemaVersion,
    payload: input.payload,
  });

export const semanticRequestFingerprint = (
  input: FingerprintInput,
): SemanticRequestFingerprint =>
  createHash("sha256")
    .update(canonicalFingerprintInput(input), "utf8")
    .digest("hex") as SemanticRequestFingerprint;
