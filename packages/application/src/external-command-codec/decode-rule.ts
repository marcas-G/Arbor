import { Actor, ID_SCHEMAS, isIsoTimestamp } from "@arbor/domain";
import { Schema } from "effect";
import type { CommandInputIssue, CommandInputIssueRule, DecodeCommandPayloadResult } from "./types.js";
import type { Rule } from "./rules.js";

const INVALID = Symbol("invalid command input");
type Invalid = typeof INVALID;
type IssueSink = Array<CommandInputIssue>;

export const decodeAgainstRule = (
  rule: Rule,
  input: unknown,
): DecodeCommandPayloadResult => {
  const issues: IssueSink = [];
  const value = decodeValue(rule, input, [], issues);
  const stableIssues = [
    ...new Map(
      issues.map((issue) => [
        `${issue.path.map((part) => `${typeof part}:${String(part)}`).join("/")}\0${issue.rule}`,
        issue,
      ]),
    ).values(),
  ].sort(compareIssues);
  if (stableIssues.length > 0 || value === INVALID) {
    return { ok: false, issues: stableIssues };
  }
  return { ok: true, value };
};

const compareIssues = (
  left: CommandInputIssue,
  right: CommandInputIssue,
): number => {
  const leftPath = left.path.map(String).join("\0");
  const rightPath = right.path.map(String).join("\0");
  return compareText(leftPath, rightPath) || compareText(left.rule, right.rule);
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const addIssue = (
  issues: IssueSink,
  path: ReadonlyArray<string | number>,
  rule: CommandInputIssueRule,
): void => {
  issues.push({ path, rule });
};

const decodeValue = (
  rule: Rule,
  input: unknown,
  path: ReadonlyArray<string | number>,
  issues: IssueSink,
): unknown | Invalid => {
  switch (rule.kind) {
    case "optional":
      return input === undefined
        ? undefined
        : decodeValue(rule.inner, input, path, issues);
    case "nullable":
      return input === null
        ? null
        : decodeValue(rule.inner, input, path, issues);
    case "string":
      if (typeof input === "string") return input;
      addIssue(issues, path, "type");
      return INVALID;
    case "non-empty-string":
      if (typeof input === "string" && input.length > 0) return input;
      addIssue(issues, path, typeof input === "string" ? "format" : "type");
      return INVALID;
    case "trimmed-non-empty-string":
      if (
        typeof input === "string" &&
        input.length > 0 &&
        input === input.trim()
      ) {
        return input;
      }
      addIssue(issues, path, typeof input === "string" ? "format" : "type");
      return INVALID;
    case "iso-timestamp":
      if (typeof input === "string" && isIsoTimestamp(input)) return input;
      addIssue(issues, path, typeof input === "string" ? "format" : "type");
      return INVALID;
    case "bounded-string":
      if (typeof input !== "string") {
        addIssue(issues, path, "type");
        return INVALID;
      }
      if (input.length < rule.minLength || input.length > rule.maxLength) {
        addIssue(issues, path, "range");
        return INVALID;
      }
      return input;
    case "opaque-identifier":
      if (
        typeof input === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input)
      ) {
        return input;
      }
      addIssue(issues, path, typeof input === "string" ? "format" : "type");
      return INVALID;
    case "boolean":
      if (typeof input === "boolean") return input;
      addIssue(issues, path, "type");
      return INVALID;
    case "integer":
      if (typeof input !== "number" || !Number.isFinite(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      if (!Number.isInteger(input) || input < 0) {
        addIssue(issues, path, "range");
        return INVALID;
      }
      return input;
    case "positive-safe-integer":
      if (typeof input !== "number" || !Number.isFinite(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      if (!Number.isSafeInteger(input) || input < 1) {
        addIssue(issues, path, "range");
        return INVALID;
      }
      return input;
    case "canonical-identifier":
      if (
        typeof input === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input)
      ) {
        return input;
      }
      addIssue(issues, path, typeof input === "string" ? "format" : "type");
      return INVALID;
    case "id":
      try {
        return Schema.decodeUnknownSync(ID_SCHEMAS[rule.idType])(input);
      } catch {
        addIssue(issues, path, typeof input === "string" ? "format" : "type");
        return INVALID;
      }
    case "actor":
      try {
        return Schema.decodeUnknownSync(Actor)(input);
      } catch {
        addIssue(issues, path, typeof input === "string" ? "format" : "type");
        return INVALID;
      }
    case "literal":
      if (input === rule.value) return input;
      addIssue(
        issues,
        path,
        typeof input === typeof rule.value ? "enum" : "type",
      );
      return INVALID;
    case "array": {
      if (!Array.isArray(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      if (
        (rule.minItems !== undefined && input.length < rule.minItems) ||
        (rule.maxItems !== undefined && input.length > rule.maxItems)
      ) {
        addIssue(issues, path, "range");
        return INVALID;
      }
      const output: unknown[] = [];
      input.forEach((item, index) => {
        const decoded = decodeValue(rule.item, item, [...path, index], issues);
        if (decoded !== INVALID && decoded !== undefined) output.push(decoded);
      });
      return output;
    }
    case "object": {
      if (!isRecord(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      const fieldNames = Object.keys(rule.fields);
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(rule.fields, key))
          addIssue(issues, [...path, "<unknown-field>"], "unknown-field");
      }
      const output: Record<string, unknown> = {};
      for (const key of fieldNames) {
        const fieldRule = rule.fields[key];
        if (fieldRule === undefined) continue;
        if (!Object.hasOwn(input, key)) {
          if (fieldRule.kind !== "optional")
            addIssue(issues, [...path, key], "required");
          continue;
        }
        const decoded = decodeValue(
          fieldRule,
          input[key],
          [...path, key],
          issues,
        );
        if (decoded !== INVALID && decoded !== undefined) {
          Object.defineProperty(output, key, {
            value: decoded,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      return output;
    }
    case "union": {
      if (rule.tag === "__enum") {
        const enumCase =
          typeof input === "string" && Object.hasOwn(rule.cases, input)
            ? rule.cases[input]
            : undefined;
        if (enumCase === undefined) {
          addIssue(issues, path, typeof input === "string" ? "enum" : "type");
          return INVALID;
        }
        return input;
      }
      if (!isRecord(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      const tagValue = input[rule.tag];
      if (typeof tagValue !== "string") {
        addIssue(
          issues,
          [...path, rule.tag],
          Object.hasOwn(input, rule.tag) ? "type" : "required",
        );
        return INVALID;
      }
      const selected = Object.hasOwn(rule.cases, tagValue)
        ? rule.cases[tagValue]
        : undefined;
      if (selected === undefined) {
        addIssue(issues, [...path, rule.tag], "enum");
        return INVALID;
      }
      return decodeValue(selected, input, path, issues);
    }
    case "record":
      if (!isRecord(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      return decodeJson(input, path, issues);
  }
};

const decodeJson = (
  input: unknown,
  path: ReadonlyArray<string | number>,
  issues: IssueSink,
): unknown | Invalid => {
  if (input === null || typeof input === "string" || typeof input === "boolean")
    return input;
  if (typeof input === "number") {
    if (Number.isFinite(input)) return input;
    addIssue(issues, path, "range");
    return INVALID;
  }
  if (Array.isArray(input)) {
    const output: unknown[] = [];
    input.forEach((value, index) => {
      const decoded = decodeJson(value, [...path, index], issues);
      if (decoded !== INVALID) output.push(decoded);
    });
    return output;
  }
  if (!isRecord(input)) {
    addIssue(issues, path, "type");
    return INVALID;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const decoded = decodeJson(value, [...path, "<unknown-field>"], issues);
    if (decoded !== INVALID)
      Object.defineProperty(output, key, {
        value: decoded,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return output;
};

