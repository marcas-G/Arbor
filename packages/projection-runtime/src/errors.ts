/** projection-runtime read failure envelope (RepositoryFailure precedent:
 * narrow per-package tag, adapter causes stay at the injection boundary). */
export interface ProjectionReadError {
  readonly _tag: "ProjectionReadFailure";
  readonly cause: unknown;
}

export const projectionReadError = (cause: unknown): ProjectionReadError => ({
  _tag: "ProjectionReadFailure",
  cause,
});
