import {
  ArtifactId,
  DeliverableId,
  parse,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  hasOnlyControlFields,
  invalidControlArguments,
  parseControlId,
  stringList,
} from "./control-decode-shared.js";
import type {
  AgentAction,
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

export const decodeAssignWorkControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, [
        "targetWorkspaceRef",
        "targetWorkspaceId",
        "objective",
        "why",
        "constraints",
        "completionExpectation",
        "verificationMission",
        "reason",
      ]) ||
      typeof object.objective !== "string" ||
      object.objective.length === 0 ||
      typeof object.why !== "string" ||
      object.why.length === 0 ||
      typeof object.completionExpectation !== "string" ||
      object.completionExpectation.length === 0 ||
      typeof object.reason !== "string" ||
      object.reason.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "AssignWork requires objective, why, completionExpectation, verificationMission, and reason",
      );
    }
    const constraints = stringList(object.constraints);
    if (constraints === null) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "AssignWork constraints must be a string array",
      );
    }
    const targetWorkspaceId =
      object.targetWorkspaceId === undefined
        ? undefined
        : parseControlId(
            invocation.toolName,
            parse(WorkspaceId),
            object.targetWorkspaceId,
          );
    if (object.targetWorkspaceId !== undefined && targetWorkspaceId === null) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "AssignWork targetWorkspaceId is malformed",
      );
    }
    const targetWorkspaceRef =
      object.targetWorkspaceRef === undefined
        ? undefined
        : typeof object.targetWorkspaceRef === "string" &&
            object.targetWorkspaceRef.length > 0
          ? object.targetWorkspaceRef
          : null;
    if (targetWorkspaceRef === null) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "AssignWork targetWorkspaceRef must be a non-empty scoped ref",
      );
    }
    if (
      targetWorkspaceRef !== undefined &&
      targetWorkspaceId !== undefined &&
      targetWorkspaceId !== null
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "AssignWork accepts either targetWorkspaceRef or legacy targetWorkspaceId, not both",
      );
    }
    const mission =
      typeof object.verificationMission === "object" &&
      object.verificationMission !== null &&
      !Array.isArray(object.verificationMission)
        ? (object.verificationMission as Record<string, unknown>)
        : null;
    const riskRequirements =
      mission === null ? null : stringList(mission.riskRequirements);
    const rawCriteria = mission?.criteria;
    if (
      mission === null ||
      !hasOnlyControlFields(mission, [
        "goal",
        "criteria",
        "riskRequirements",
      ]) ||
      typeof mission.goal !== "string" ||
      mission.goal.length === 0 ||
      riskRequirements === null ||
      !Array.isArray(rawCriteria) ||
      rawCriteria.length === 0 ||
      rawCriteria.some(
        (criterion) =>
          typeof criterion !== "object" ||
          criterion === null ||
          Array.isArray(criterion) ||
          !hasOnlyControlFields(criterion as Record<string, unknown>, [
            "criterionId",
            "requirement",
            "required",
          ]) ||
          typeof (criterion as Record<string, unknown>).criterionId !==
            "string" ||
          ((criterion as Record<string, unknown>).criterionId as string)
            .length === 0 ||
          typeof (criterion as Record<string, unknown>).requirement !==
            "string" ||
          ((criterion as Record<string, unknown>).requirement as string)
            .length === 0 ||
          typeof (criterion as Record<string, unknown>).required !== "boolean",
      ) ||
      !rawCriteria.some(
        (criterion) => (criterion as Record<string, unknown>).required === true,
      )
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "AssignWork verificationMission requires a goal, criteria with at least one required item, and riskRequirements",
      );
    }
    const criteria = rawCriteria.map(
      (criterion) =>
        criterion as {
          readonly criterionId: string;
          readonly requirement: string;
          readonly required: boolean;
        },
    );
    const action: Extract<AgentAction, { readonly _tag: "AssignWork" }> = {
      _tag: "AssignWork",
      ...(targetWorkspaceRef === undefined ? {} : { targetWorkspaceRef }),
      ...(targetWorkspaceId === undefined || targetWorkspaceId === null
        ? {}
        : { targetWorkspaceId }),
      objective: object.objective,
      why: object.why,
      constraints,
      completionExpectation: object.completionExpectation,
      verificationMission: {
        goal: mission.goal,
        criteria,
        riskRequirements,
      },
      reason: object.reason,
    };
    return { invocation, action };
  });

export const decodeProduceDeliverableControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["kind", "artifacts"]) ||
      typeof object.kind !== "string" ||
      object.kind.length === 0 ||
      !Array.isArray(object.artifacts)
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "produce_deliverable requires kind and artifacts",
      );
    }
    const artifacts: Array<{
      role: string;
      artifactId: import("@arbor/domain").ArtifactId;
    }> = [];
    for (const candidate of object.artifacts) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        !hasOnlyControlFields(candidate as Record<string, unknown>, [
          "role",
          "artifactId",
        ]) ||
        typeof (candidate as Record<string, unknown>).role !== "string" ||
        typeof (candidate as Record<string, unknown>).artifactId !== "string"
      ) {
        return yield* invalidControlArguments(
          invocation.toolName,
          "each artifact requires role and art_ artifactId",
        );
      }
      try {
        artifacts.push({
          role: (candidate as Record<string, unknown>).role as string,
          artifactId: parse(ArtifactId)(
            (candidate as Record<string, unknown>).artifactId,
          ),
        });
      } catch {
        return yield* invalidControlArguments(
          invocation.toolName,
          "artifactId is malformed",
        );
      }
    }
    return {
      invocation,
      action: {
        _tag: "ProduceDeliverable",
        kind: object.kind,
        artifacts,
      },
    };
  });

export const decodeDeliverControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["deliverableId", "summary"]) ||
      typeof object.deliverableId !== "string" ||
      typeof object.summary !== "string" ||
      object.summary.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "deliver requires deliverableId and summary",
      );
    }
    try {
      return {
        invocation,
        action: {
          _tag: "Deliver",
          deliverableId: parse(DeliverableId)(object.deliverableId),
          summary: object.summary,
        },
      };
    } catch {
      return yield* invalidControlArguments(
        invocation.toolName,
        "deliverableId is malformed",
      );
    }
  });

export const decodeUpdatePlanControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> => {
  if (
    !hasOnlyControlFields(object, ["items"]) ||
    !Array.isArray(object.items)
  ) {
    return invalidControlArguments(invocation.toolName, "invalid plan items");
  }
  const items: Array<{
    readonly itemId: string;
    readonly text: string;
    readonly status: "Pending" | "InProgress" | "Completed" | "Blocked";
  }> = [];
  const statuses = new Set(["Pending", "InProgress", "Completed", "Blocked"]);
  for (const value of object.items) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalidControlArguments(invocation.toolName, "invalid plan item");
    }
    const item = value as Record<string, unknown>;
    if (
      !hasOnlyControlFields(item, ["itemId", "text", "status"]) ||
      typeof item.itemId !== "string" ||
      item.itemId.length === 0 ||
      typeof item.text !== "string" ||
      item.text.length === 0 ||
      typeof item.status !== "string" ||
      !statuses.has(item.status)
    ) {
      return invalidControlArguments(invocation.toolName, "invalid plan item");
    }
    items.push({
      itemId: item.itemId,
      text: item.text,
      status: item.status as (typeof items)[number]["status"],
    });
  }
  if (items.length === 0) {
    return invalidControlArguments(
      invocation.toolName,
      "plan requires at least one item",
    );
  }
  return Effect.succeed({
    invocation,
    action: { _tag: "UpdatePlan", items },
  });
};

export const decodeSelectCurrentWorkControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> => {
  if (!hasOnlyControlFields(object, ["workId"])) {
    return invalidControlArguments(
      invocation.toolName,
      "invalid work selection",
    );
  }
  const workId = parseControlId(
    invocation.toolName,
    parse(WorkId),
    object.workId,
  );
  return workId === null
    ? invalidControlArguments(invocation.toolName, "invalid selected workId")
    : Effect.succeed({
        invocation,
        action: { _tag: "SelectCurrentWork", workId },
      });
};

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
