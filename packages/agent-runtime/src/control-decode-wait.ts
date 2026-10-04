import type { WaitSpec } from "@arbor/domain";
import {
  DecisionId,
  DependencyId,
  parse,
  Revision,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  hasOnlyControlFields,
  invalidControlArguments,
  nonEmptyString,
  parseControlField,
} from "./control-decode-shared.js";
import type {
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

const decodeWaitSpec = (
  invocation: ToolInvocation,
  value: unknown,
): Effect.Effect<WaitSpec, ControlToolDecodeError> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasOnlyControlFields(value as Record<string, unknown>, [
      "mode",
      "conditions",
    ])
  ) {
    return invalidControlArguments(
      invocation.toolName,
      "waitSpec must be a closed object",
    );
  }
  const spec = value as Record<string, unknown>;
  if (
    spec.mode !== "Any" ||
    !Array.isArray(spec.conditions) ||
    spec.conditions.length === 0
  ) {
    return invalidControlArguments(
      invocation.toolName,
      "waitSpec requires mode Any and at least one condition",
    );
  }
  const conditions: WaitSpec["conditions"][number][] = [];
  for (const candidate of spec.conditions) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return invalidControlArguments(
        invocation.toolName,
        "wake condition must be an object",
      );
    }
    const condition = candidate as Record<string, unknown>;
    switch (condition._tag) {
      case "DependencyChanged": {
        const dependencyId = parseControlField(
          invocation.toolName,
          parse(DependencyId),
          condition.dependencyId,
        );
        const observedRevision = parseControlField(
          invocation.toolName,
          parse(Revision),
          condition.observedRevision,
        );
        if (
          !hasOnlyControlFields(condition, [
            "_tag",
            "dependencyId",
            "observedRevision",
          ]) ||
          dependencyId === null ||
          observedRevision === null
        ) {
          return invalidControlArguments(
            invocation.toolName,
            "invalid DependencyChanged condition",
          );
        }
        conditions.push({
          _tag: "DependencyChanged",
          dependencyId,
          observedRevision,
        });
        break;
      }
      case "DecisionChanged": {
        const decisionId = parseControlField(
          invocation.toolName,
          parse(DecisionId),
          condition.decisionId,
        );
        const observedRevision = parseControlField(
          invocation.toolName,
          parse(Revision),
          condition.observedRevision,
        );
        if (
          !hasOnlyControlFields(condition, [
            "_tag",
            "decisionId",
            "observedRevision",
          ]) ||
          decisionId === null ||
          observedRevision === null
        ) {
          return invalidControlArguments(
            invocation.toolName,
            "invalid DecisionChanged condition",
          );
        }
        conditions.push({
          _tag: "DecisionChanged",
          decisionId,
          observedRevision,
        });
        break;
      }
      case "VerificationChanged": {
        const workId = parseControlField(
          invocation.toolName,
          parse(WorkId),
          condition.workId,
        );
        const targetWorkRevision = parseControlField(
          invocation.toolName,
          parse(Revision),
          condition.targetWorkRevision,
        );
        if (
          !hasOnlyControlFields(condition, [
            "_tag",
            "workId",
            "targetWorkRevision",
          ]) ||
          workId === null ||
          targetWorkRevision === null
        ) {
          return invalidControlArguments(
            invocation.toolName,
            "invalid VerificationChanged condition",
          );
        }
        conditions.push({
          _tag: "VerificationChanged",
          workId,
          targetWorkRevision,
        });
        break;
      }
      case "InboxAdvanced": {
        const workspaceId = parseControlField(
          invocation.toolName,
          parse(WorkspaceId),
          condition.workspaceId,
        );
        if (
          !hasOnlyControlFields(condition, [
            "_tag",
            "workspaceId",
            "observedSequence",
          ]) ||
          workspaceId === null ||
          !Number.isInteger(condition.observedSequence) ||
          (condition.observedSequence as number) < 0
        ) {
          return invalidControlArguments(
            invocation.toolName,
            "invalid InboxAdvanced condition",
          );
        }
        conditions.push({
          _tag: "InboxAdvanced",
          workspaceId,
          observedSequence: condition.observedSequence as number,
        });
        break;
      }
      case "EnvironmentChanged":
        if (
          !hasOnlyControlFields(condition, [
            "_tag",
            "environmentRef",
            "observedRevision",
          ]) ||
          !nonEmptyString(condition.environmentRef) ||
          !nonEmptyString(condition.observedRevision)
        ) {
          return invalidControlArguments(
            invocation.toolName,
            "invalid EnvironmentChanged condition",
          );
        }
        conditions.push({
          _tag: "EnvironmentChanged",
          environmentRef: condition.environmentRef,
          observedRevision: condition.observedRevision,
        });
        break;
      case "TimeReached":
        if (
          !hasOnlyControlFields(condition, ["_tag", "instant"]) ||
          !nonEmptyString(condition.instant) ||
          Number.isNaN(Date.parse(condition.instant))
        ) {
          return invalidControlArguments(
            invocation.toolName,
            "invalid TimeReached condition",
          );
        }
        conditions.push({ _tag: "TimeReached", instant: condition.instant });
        break;
      case "Manual":
        if (!hasOnlyControlFields(condition, ["_tag"])) {
          return invalidControlArguments(
            invocation.toolName,
            "invalid Manual condition",
          );
        }
        conditions.push({ _tag: "Manual" });
        break;
      default:
        return invalidControlArguments(
          invocation.toolName,
          "unknown wake condition",
        );
    }
  }
  return Effect.succeed({ mode: "Any", conditions });
};

export const decodeWaitControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["reason", "waitSpec"]) ||
      typeof object.reason !== "string" ||
      object.reason.length === 0 ||
      typeof object.waitSpec !== "object" ||
      object.waitSpec === null ||
      Array.isArray(object.waitSpec)
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "invalid Wait arguments",
      );
    }
    const waitSpec = yield* decodeWaitSpec(invocation, object.waitSpec);
    return {
      invocation,
      action: {
        _tag: "Wait",
        reason: object.reason,
        waitSpec,
      },
    };
  });
