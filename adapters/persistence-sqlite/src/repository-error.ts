import type { RepositoryFailure } from "@arbor/ports";

const recordOf = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const reasonOf = (
  cause: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  const record = recordOf(cause);
  return recordOf(record?.reason);
};

const sourceTagOf = (cause: unknown): string => {
  const reason = reasonOf(cause);
  if (typeof reason?._tag === "string") return reason._tag;
  const record = recordOf(cause);
  return typeof record?._tag === "string" ? record._tag : "UntaggedSqlError";
};

const constraintOf = (cause: unknown): string => {
  const constraint = reasonOf(cause)?.constraint;
  return typeof constraint === "string" && constraint.length > 0
    ? constraint
    : "unknown";
};

/** Translate Effect SQL/native errors at the SQLite adapter boundary. Native
 * causes remain only on PersistenceUnavailable; semantic constraint facts are
 * safe structured data and never require callers to inspect SqlError.cause. */
export const repositoryFailure =
  <Tag extends string>(
    repository: Tag,
    operation: string,
  ): ((cause: unknown) => RepositoryFailure<Tag>) =>
  (cause) => {
    const sourceTag = sourceTagOf(cause);
    if (sourceTag === "UniqueViolation") {
      return {
        _tag: "PersistenceConstraintViolation",
        repository,
        operation,
        constraintKind: "Unique",
        constraint: constraintOf(cause),
      };
    }
    if (sourceTag === "ConstraintError") {
      return {
        _tag: "PersistenceConstraintViolation",
        repository,
        operation,
        constraintKind: "Constraint",
        constraint: constraintOf(cause),
      };
    }
    const retryable = recordOf(cause)?.isRetryable === true;
    return {
      _tag: "PersistenceUnavailable",
      repository,
      operation,
      retryDisposition: retryable ? "retryable" : "non-retryable",
      sourceTag,
      cause,
    };
  };

export const persistenceCorruption = <Tag extends string>(
  repository: Tag,
  operation: string,
  reason: string,
): RepositoryFailure<Tag> => ({
  _tag: "PersistenceCorruption",
  repository,
  operation,
  reason,
});
