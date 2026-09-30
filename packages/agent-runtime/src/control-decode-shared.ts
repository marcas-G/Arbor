import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import type { ControlToolDecodeError } from "./control-types.js";

export const invalidControlArguments = (
  toolName: string,
  reason: string,
): Effect.Effect<never, ControlToolDecodeError> =>
  Effect.fail({
    _tag: "InvalidControlArguments",
    toolName,
    reason,
  });

export const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const parseControlId = <A>(
  _toolName: string,
  parser: (value: string) => A,
  value: unknown,
): A | null => {
  if (!nonEmptyString(value)) return null;
  try {
    return parser(value);
  } catch {
    return null;
  }
};

export const parseControlObject = (
  invocation: ToolInvocation,
): Effect.Effect<Record<string, unknown>, ControlToolDecodeError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(invocation.argumentsJson);
  } catch {
    return invalidControlArguments(
      invocation.toolName,
      "arguments are not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalidControlArguments(
      invocation.toolName,
      "arguments must be a JSON object",
    );
  }
  return Effect.succeed(parsed as Record<string, unknown>);
};

export const hasOnlyControlFields = (
  object: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean => Object.keys(object).every((key) => keys.includes(key));

export const stringList = (value: unknown): ReadonlyArray<string> | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
