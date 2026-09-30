import { parse, WorkId, WorkspaceId } from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  hasOnlyControlFields,
  invalidControlArguments,
  parseControlId,
  stringList,
} from "./control-decode-shared.js";
import type {
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

export const decodeClaimCompletionControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> => {
  if (
    !hasOnlyControlFields(object, ["claim"]) ||
    typeof object.claim !== "string" ||
    object.claim.length === 0
  ) {
    return invalidControlArguments(
      invocation.toolName,
      "invalid ClaimCompletion arguments",
    );
  }
  return Effect.succeed({
    invocation,
    action: {
      _tag: "ClaimCompletion",
      claim: object.claim,
    },
  });
};

export const decodeDeclareDependencyControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["producerBinding", "expectedDeliverable"])
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "invalid DeclareDependency arguments",
      );
    }
    const rawBinding = object.producerBinding;
    if (
      typeof rawBinding !== "object" ||
      rawBinding === null ||
      Array.isArray(rawBinding)
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "producerBinding must be an object",
      );
    }
    const binding = rawBinding as Record<string, unknown>;
    let producerBinding:
      | { readonly _tag: "AnyProducer" }
      | { readonly _tag: "WorkspaceBound"; readonly workspaceId: WorkspaceId }
      | { readonly _tag: "WorkBound"; readonly workId: WorkId };
    if (
      hasOnlyControlFields(binding, ["_tag"]) &&
      binding._tag === "AnyProducer"
    ) {
      producerBinding = { _tag: "AnyProducer" };
    } else if (
      hasOnlyControlFields(binding, ["_tag", "workspaceId"]) &&
      binding._tag === "WorkspaceBound"
    ) {
      const workspaceId = parseControlId(
        invocation.toolName,
        parse(WorkspaceId),
        binding.workspaceId,
      );
      if (workspaceId === null) {
        return yield* invalidControlArguments(
          invocation.toolName,
          "WorkspaceBound requires a valid workspaceId",
        );
      }
      producerBinding = { _tag: "WorkspaceBound", workspaceId };
    } else if (
      hasOnlyControlFields(binding, ["_tag", "workId"]) &&
      binding._tag === "WorkBound"
    ) {
      const workId = parseControlId(
        invocation.toolName,
        parse(WorkId),
        binding.workId,
      );
      if (workId === null) {
        return yield* invalidControlArguments(
          invocation.toolName,
          "WorkBound requires a valid workId",
        );
      }
      producerBinding = { _tag: "WorkBound", workId };
    } else {
      return yield* invalidControlArguments(
        invocation.toolName,
        "producerBinding must be AnyProducer, WorkspaceBound, or WorkBound",
      );
    }
    const rawDeliverable = object.expectedDeliverable;
    if (
      typeof rawDeliverable !== "object" ||
      rawDeliverable === null ||
      Array.isArray(rawDeliverable)
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "expectedDeliverable must be an object",
      );
    }
    const deliverable = rawDeliverable as Record<string, unknown>;
    const roles = stringList(deliverable.requiredArtifactRoles);
    if (
      !hasOnlyControlFields(deliverable, ["kind", "requiredArtifactRoles"]) ||
      typeof deliverable.kind !== "string" ||
      deliverable.kind.length === 0 ||
      roles === null
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "expectedDeliverable requires a kind and string-array roles",
      );
    }
    return {
      invocation,
      action: {
        _tag: "DeclareDependency",
        producerBinding,
        expectedDeliverable: {
          kind: deliverable.kind,
          requiredArtifactRoles: roles,
        },
      },
    };
  });
