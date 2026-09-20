export interface SqliteAdapterError {
  readonly _tag: "SqliteAdapterError";
  readonly message: string;
  readonly cause?: unknown;
}

export const sqliteAdapterError = (
  message: string,
  cause?: unknown,
): SqliteAdapterError =>
  cause === undefined
    ? { _tag: "SqliteAdapterError", message }
    : { _tag: "SqliteAdapterError", message, cause };
