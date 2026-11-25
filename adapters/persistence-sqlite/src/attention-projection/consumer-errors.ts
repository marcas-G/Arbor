import {
  type ConsumerOffsetStoreError,
} from "@arbor/ports";

export const payloadRecord = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

export const projectionFailure = (cause: unknown): ConsumerOffsetStoreError => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly _tag?: unknown })._tag === "PersistenceUnavailable"
  ) {
    const unavailable = cause as {
      readonly operation: string;
      readonly retryDisposition: "retryable" | "non-retryable";
      readonly sourceTag: string;
      readonly cause: unknown;
    };
    return {
      _tag: "PersistenceUnavailable",
      repository: "ConsumerOffsetStore",
      operation: unavailable.operation,
      retryDisposition: unavailable.retryDisposition,
      sourceTag: unavailable.sourceTag,
      cause: unavailable.cause,
    };
  }
  return {
    _tag: "PersistenceCorruption",
    repository: "ConsumerOffsetStore",
    operation: "p10-attention-apply",
    reason: "P10 Attention source fact or projection row failed validation",
  };
};
