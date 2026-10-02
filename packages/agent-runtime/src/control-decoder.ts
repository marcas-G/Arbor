import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  decodeProposeChildWorkspaceControl,
  decodeSendMessageControl,
} from "./control-decode-coordination.js";
import { decodeSpawnSpecialistControl } from "./control-decode-delegation.js";
import { parseControlObject } from "./control-decode-shared.js";
import {
  decodeConcludeVerificationControl,
  decodeRecordVerificationEvidenceControl,
} from "./control-decode-verification.js";
import { decodeWaitControl } from "./control-decode-wait.js";
import {
  decodeClaimCompletionControl,
  decodeDeclareDependencyControl,
} from "./control-decode-work.js";
import type {
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

const CONTROL_TOOL_NAMES = new Set([
  "arbor_wait",
  "arbor_send_message",
  "arbor_claim_completion",
  "arbor_propose_child_workspace",
  "arbor_spawn_specialist",
  "arbor_declare_dependency",
  "arbor_record_verification_evidence",
  "arbor_conclude_verification",
]);

export const decodeControlInvocation = (
  invocation: ToolInvocation,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (!CONTROL_TOOL_NAMES.has(invocation.toolName)) {
      return yield* Effect.fail<ControlToolDecodeError>({
        _tag: "UnknownControlTool",
        toolName: invocation.toolName,
      });
    }
    const object = yield* parseControlObject(invocation);
    switch (invocation.toolName) {
      case "arbor_wait":
        return yield* decodeWaitControl(invocation, object);
      case "arbor_send_message":
        return yield* decodeSendMessageControl(invocation, object);
      case "arbor_claim_completion":
        return yield* decodeClaimCompletionControl(invocation, object);
      case "arbor_propose_child_workspace":
        return yield* decodeProposeChildWorkspaceControl(invocation, object);
      case "arbor_spawn_specialist":
        return yield* decodeSpawnSpecialistControl(invocation, object);
      case "arbor_declare_dependency":
        return yield* decodeDeclareDependencyControl(invocation, object);
      case "arbor_record_verification_evidence":
        return yield* decodeRecordVerificationEvidenceControl(
          invocation,
          object,
        );
      case "arbor_conclude_verification":
        return yield* decodeConcludeVerificationControl(invocation, object);
      default:
        return yield* Effect.fail<ControlToolDecodeError>({
          _tag: "UnknownControlTool",
          toolName: invocation.toolName,
        });
    }
  });
