import { EvidenceId, parse } from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  hasOnlyControlFields,
  invalidControlArguments,
  parseControlField,
} from "./control-decode-shared.js";
import type {
  AgentAction,
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

const verdict = (value: unknown) =>
  value === "Pass" || value === "Fail" || value === "Unknown" ? value : null;

export const decodeRecordVerificationEvidenceControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["criterionId", "sourceCallRef"]) ||
      typeof object.criterionId !== "string" ||
      object.criterionId.length === 0 ||
      typeof object.sourceCallRef !== "string" ||
      object.sourceCallRef.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "criterionId and sourceCallRef are required",
      );
    }
    return {
      invocation,
      action: {
        _tag: "RecordVerificationEvidence",
        criterionId: object.criterionId,
        sourceCallRef: object.sourceCallRef,
      },
    };
  });

export const decodeConcludeVerificationControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    const overallVerdict = verdict(object.verdict);
    if (
      !hasOnlyControlFields(object, [
        "verdict",
        "criteriaResults",
        "summary",
      ]) ||
      overallVerdict === null ||
      typeof object.summary !== "string" ||
      object.summary.length === 0 ||
      !Array.isArray(object.criteriaResults) ||
      object.criteriaResults.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "verdict, non-empty criteriaResults, and summary are required",
      );
    }
    const criteriaResults: Array<
      Extract<
        AgentAction,
        { readonly _tag: "ConcludeVerification" }
      >["criteriaResults"][number]
    > = [];
    for (const candidate of object.criteriaResults) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate)
      ) {
        return yield* invalidControlArguments(
          invocation.toolName,
          "every criterion result must be an object",
        );
      }
      const result = candidate as Record<string, unknown>;
      const criterionVerdict = verdict(result.verdict);
      if (
        !hasOnlyControlFields(result, [
          "criterionId",
          "requirement",
          "required",
          "verdict",
          "evidenceRefs",
        ]) ||
        typeof result.criterionId !== "string" ||
        result.criterionId.length === 0 ||
        typeof result.requirement !== "string" ||
        result.requirement.length === 0 ||
        typeof result.required !== "boolean" ||
        criterionVerdict === null ||
        !Array.isArray(result.evidenceRefs) ||
        result.evidenceRefs.length === 0
      ) {
        return yield* invalidControlArguments(
          invocation.toolName,
          "invalid criterion result",
        );
      }
      const evidenceRefs = result.evidenceRefs.map((value) =>
        parseControlField(invocation.toolName, parse(EvidenceId), value),
      );
      if (evidenceRefs.some((value) => value === null)) {
        return yield* invalidControlArguments(
          invocation.toolName,
          "evidenceRefs must contain valid EvidenceIds",
        );
      }
      criteriaResults.push({
        criterionId: result.criterionId,
        requirement: result.requirement,
        required: result.required,
        verdict: criterionVerdict,
        evidenceRefs: evidenceRefs as ReadonlyArray<
          import("@arbor/domain").EvidenceId
        >,
      });
    }
    return {
      invocation,
      action: {
        _tag: "ConcludeVerification",
        verdict: overallVerdict,
        criteriaResults,
        summary: object.summary,
      },
    };
  });
