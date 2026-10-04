import { MessageId, parse, WorkspaceId } from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  hasOnlyControlFields,
  invalidControlArguments,
  parseControlField,
  stringList,
} from "./control-decode-shared.js";
import type {
  AgentAction,
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

const decodeChildWorkspaceProposal = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<
  Extract<AgentAction, { readonly _tag: "ProposeChildWorkspace" }>["proposal"],
  ControlToolDecodeError
> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, [
        "name",
        "rationale",
        "responsibilityDraft",
        "resourceBoundaryDraft",
        "initialWork",
      ]) ||
      typeof object.name !== "string" ||
      object.name.length === 0 ||
      typeof object.rationale !== "string" ||
      object.rationale.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "invalid ProposeChildWorkspace arguments",
      );
    }
    const draft =
      typeof object.responsibilityDraft === "object" &&
      object.responsibilityDraft !== null &&
      !Array.isArray(object.responsibilityDraft)
        ? (object.responsibilityDraft as Record<string, unknown>)
        : null;
    if (
      draft === null ||
      !hasOnlyControlFields(draft, [
        "purpose",
        "ownedResponsibilities",
        "obligations",
        "includes",
        "excludes",
        "interfaces",
      ]) ||
      typeof draft.purpose !== "string" ||
      draft.purpose.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "responsibilityDraft must carry a non-empty purpose and closed fields",
      );
    }
    const listOr = (key: string): ReadonlyArray<string> | null =>
      draft[key] === undefined ? [] : stringList(draft[key]);
    const owned = listOr("ownedResponsibilities");
    const obligations = listOr("obligations");
    const includes = listOr("includes");
    const excludes = listOr("excludes");
    const interfaces = listOr("interfaces");
    if (
      owned === null ||
      obligations === null ||
      includes === null ||
      excludes === null ||
      interfaces === null
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "responsibilityDraft lists must be string arrays",
      );
    }
    const boundary =
      typeof object.resourceBoundaryDraft === "object" &&
      object.resourceBoundaryDraft !== null &&
      !Array.isArray(object.resourceBoundaryDraft)
        ? (object.resourceBoundaryDraft as Record<string, unknown>)
        : null;
    if (boundary === null || !hasOnlyControlFields(boundary, ["addresses"])) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "resourceBoundaryDraft must carry addresses",
      );
    }
    const rawAddresses = boundary.addresses;
    if (
      !Array.isArray(rawAddresses) ||
      rawAddresses.length === 0 ||
      rawAddresses.some(
        (item) =>
          typeof item !== "object" ||
          item === null ||
          Array.isArray(item) ||
          !hasOnlyControlFields(item as Record<string, unknown>, [
            "_tag",
            "path",
          ]) ||
          ((item as Record<string, unknown>)._tag !== "FileTree" &&
            (item as Record<string, unknown>)._tag !== "GitWorktree") ||
          typeof (item as Record<string, unknown>).path !== "string" ||
          ((item as Record<string, unknown>).path as string).length === 0,
      )
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "resource addresses must be FileTree/GitWorktree with a path",
      );
    }
    const addresses = rawAddresses.map(
      (item) =>
        item as {
          readonly _tag: "FileTree" | "GitWorktree";
          readonly path: string;
        },
    );
    let initialWork:
      | Extract<
          AgentAction,
          { readonly _tag: "ProposeChildWorkspace" }
        >["proposal"]["initialWork"]
      | undefined;
    if (object.initialWork !== undefined) {
      const work =
        typeof object.initialWork === "object" &&
        object.initialWork !== null &&
        !Array.isArray(object.initialWork)
          ? (object.initialWork as Record<string, unknown>)
          : null;
      const constraints = work === null ? null : stringList(work.constraints);
      if (
        work === null ||
        !hasOnlyControlFields(work, [
          "objective",
          "why",
          "constraints",
          "completionExpectation",
          "verificationMission",
        ]) ||
        typeof work.objective !== "string" ||
        work.objective.length === 0 ||
        typeof work.why !== "string" ||
        work.why.length === 0 ||
        constraints === null ||
        typeof work.completionExpectation !== "string" ||
        work.completionExpectation.length === 0
      ) {
        return yield* invalidControlArguments(
          invocation.toolName,
          "initialWork must carry objective, why, constraints, completionExpectation, verificationMission",
        );
      }
      const mission =
        typeof work.verificationMission === "object" &&
        work.verificationMission !== null &&
        !Array.isArray(work.verificationMission)
          ? (work.verificationMission as Record<string, unknown>)
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
            typeof (criterion as Record<string, unknown>).required !==
              "boolean",
        ) ||
        !rawCriteria.some(
          (criterion) =>
            (criterion as Record<string, unknown>).required === true,
        )
      ) {
        return yield* invalidControlArguments(
          invocation.toolName,
          "verificationMission must carry a non-empty goal, at least one required criterion, and riskRequirements",
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
      initialWork = {
        objective: work.objective,
        why: work.why,
        constraints,
        completionExpectation: work.completionExpectation,
        verificationMission: {
          goal: mission.goal,
          criteria,
          riskRequirements,
        },
      };
    }
    return {
      name: object.name,
      rationale: object.rationale,
      responsibilityDraft: {
        purpose: draft.purpose,
        ownedResponsibilities: owned,
        obligations,
        includes,
        excludes,
        interfaces,
      },
      resourceBoundaryDraft: { addresses },
      ...(initialWork === undefined ? {} : { initialWork }),
    };
  });

export const decodeSendMessageControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    const kind = object.kind;
    const body = object.body;
    if (
      !hasOnlyControlFields(object, [
        "kind",
        "body",
        "recipientWorkspaceId",
        "queryMessageId",
      ]) ||
      (kind !== "Query" &&
        kind !== "Reply" &&
        kind !== "Report" &&
        kind !== "DecisionRequest") ||
      typeof body !== "string" ||
      body.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "invalid SendMessage arguments",
      );
    }
    if (
      kind === "Query" &&
      (typeof object.recipientWorkspaceId !== "string" ||
        object.recipientWorkspaceId.length === 0)
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "Query requires recipientWorkspaceId",
      );
    }
    const recipientWorkspaceId =
      object.recipientWorkspaceId === undefined
        ? undefined
        : parseControlField(
            invocation.toolName,
            parse(WorkspaceId),
            object.recipientWorkspaceId,
          );
    const queryMessageId =
      object.queryMessageId === undefined
        ? undefined
        : parseControlField(
            invocation.toolName,
            parse(MessageId),
            object.queryMessageId,
          );
    if (
      (object.recipientWorkspaceId !== undefined &&
        recipientWorkspaceId === null) ||
      (object.queryMessageId !== undefined && queryMessageId === null)
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "target identity is malformed",
      );
    }
    return {
      invocation,
      action: {
        _tag: "SendMessage",
        kind,
        body,
        ...(recipientWorkspaceId !== undefined && recipientWorkspaceId !== null
          ? { recipientWorkspaceId }
          : {}),
        ...(queryMessageId !== undefined && queryMessageId !== null
          ? { queryMessageId }
          : {}),
      },
    };
  });

export const decodeProposeChildWorkspaceControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    const proposal = yield* decodeChildWorkspaceProposal(invocation, object);
    return {
      invocation,
      action: {
        _tag: "ProposeChildWorkspace",
        proposal,
      },
    };
  });
