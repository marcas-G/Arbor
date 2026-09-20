/** P4 `02` §2 step 1. Minimal deterministic JSON-schema subset used to validate
 * tool arguments against the frozen `inputSchemaJson` (G6). */

export type ValidationResult =
  | { readonly _tag: "Ok" }
  | { readonly _tag: "Invalid"; readonly reason: string };

export const validateToolInput = (
  schemaJson: string,
  argumentsJson: string,
): ValidationResult => {
  let schema: {
    required?: ReadonlyArray<string>;
    properties?: Record<string, unknown>;
  };
  let args: unknown;
  try {
    schema = JSON.parse(schemaJson) as typeof schema;
  } catch {
    return { _tag: "Invalid", reason: "schema is not valid JSON" };
  }
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return { _tag: "Invalid", reason: "arguments are not valid JSON" };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { _tag: "Invalid", reason: "arguments must be an object" };
  }
  const record = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (record[key] === undefined) {
      return { _tag: "Invalid", reason: `missing required field ${key}` };
    }
  }
  return { _tag: "Ok" };
};
