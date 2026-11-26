import type {
  PortableOperationKind,
  PortableToolResultStatus,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";

const canonicalJsonValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/**
 * P12-DG-01 D2 request identity. The hash remains the operation path's
 * existing opaque stable hash; the operation kind provides the namespace.
 */
export const providerTurnSafetyFingerprint = (
  operationKind: PortableOperationKind,
  compiledRequestHash: string,
): string => `provider-turn:${operationKind}:${compiledRequestHash}`;

/**
 * Internal D2 action identity: semantic route/name/JSON arguments only.
 * callRef and provider/step/invocation identity intentionally do not enter.
 */
export const agentActionSafetyFingerprint = (
  routeKind: "Control" | "Executable",
  actionName: string,
  argumentsJson: string,
): string => {
  let canonicalArguments: string;
  try {
    canonicalArguments = canonicalJsonValue(
      JSON.parse(argumentsJson) as unknown,
    );
  } catch {
    // Invalid JSON is still a deterministic rejected action, but is never
    // normalized as if it were a valid semantic argument object.
    canonicalArguments = `invalid-json:${argumentsJson}`;
  }
  return `agent-action:${sha256Hex(
    JSON.stringify({ routeKind, actionName, canonicalArguments }),
  )}`;
};

/** A sourced unsuccessful result is durable context, not shared D2/D4 progress. */
export const isDurableSuccessfulActionProgress = (input: {
  readonly persistenceCommitted: boolean;
  readonly status: PortableToolResultStatus;
}): boolean => input.persistenceCommitted && input.status === "Succeeded";
