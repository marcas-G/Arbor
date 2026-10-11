/** projection-runtime read failure envelope (RepositoryFailure precedent:
 * narrow per-package tag, adapter causes stay at the injection boundary). */
export interface ProjectionReadError {
  readonly _tag: "ProjectionReadFailure";
  readonly cause: unknown;
}

export interface ProjectionIntegrityFailure {
  readonly _tag: "ProjectionIntegrityFailure";
  readonly code: "projection/unavailable";
  readonly category: "unavailable";
  readonly correlationId: null;
  readonly retryDisposition: "non-retryable";
  readonly safeDetails: Readonly<Record<string, unknown>>;
}

export type ProjectionReadResultError =
  | ProjectionReadError
  | ProjectionIntegrityFailure;

export const projectionReadError = (cause: unknown): ProjectionReadError => ({
  _tag: "ProjectionReadFailure",
  cause,
});
