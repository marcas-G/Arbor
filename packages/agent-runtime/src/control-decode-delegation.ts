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
