import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  hasOnlyControlFields,
  invalidControlArguments,
  stringList,
} from "./control-decode-shared.js";
import type {
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

export const decodeListWorkspacesControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["cursor", "query"]) ||
      (object.cursor !== undefined &&
        (typeof object.cursor !== "string" || object.cursor.length === 0)) ||
      (object.query !== undefined &&
        (typeof object.query !== "string" || object.query.length === 0))
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "list_workspaces accepts optional non-empty cursor/query strings",
      );
    }
    return {
      invocation,
      action: {
        _tag: "ListWorkspaces",
        ...(typeof object.cursor === "string" ? { cursor: object.cursor } : {}),
        ...(typeof object.query === "string" ? { query: object.query } : {}),
      },
    };
  });

export const decodeReadWorkspaceControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["workspaceRef"]) ||
      typeof object.workspaceRef !== "string" ||
      object.workspaceRef.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "read_workspace requires one scoped workspaceRef",
      );
    }
    return {
      invocation,
      action: { _tag: "ReadWorkspace", workspaceRef: object.workspaceRef },
    };
  });

export const decodeAcceptResultControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["resultRef"]) ||
      typeof object.resultRef !== "string" ||
      !object.resultRef.startsWith("rref_")
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "accept_result requires one scoped rref_ resultRef",
      );
    }
    return {
      invocation,
      action: { _tag: "AcceptResult", resultRef: object.resultRef },
    };
  });

export const decodeSpawnSpecialistControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      !hasOnlyControlFields(object, ["mission", "constraints"]) ||
      typeof object.mission !== "string" ||
      object.mission.length === 0
    ) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "invalid SpawnSpecialist arguments",
      );
    }
    const constraints =
      object.constraints === undefined ? [] : stringList(object.constraints);
    if (constraints === null) {
      return yield* invalidControlArguments(
        invocation.toolName,
        "constraints must be a string array",
      );
    }
    return {
      invocation,
      action: {
        _tag: "SpawnSpecialist",
        mission: object.mission,
        constraints,
      },
    };
  });
