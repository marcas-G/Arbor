import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  decodeProposeChildWorkspaceControl,
  decodeSendMessageControl,
} from "./control-decode-coordination.js";
import {
  decodeAcceptResultControl,
  decodeListWorkspacesControl,
  decodeReadWorkspaceControl,
  decodeSpawnSpecialistControl,
} from "./control-decode-delegation.js";
import { parseControlObject } from "./control-decode-shared.js";
import {
  decodeConcludeVerificationControl,
  decodeRecordVerificationEvidenceControl,
} from "./control-decode-verification.js";
import { decodeWaitControl } from "./control-decode-wait.js";
import {
  decodeAssignWorkControl,
  decodeClaimCompletionControl,
  decodeDeclareDependencyControl,
  decodeDeliverControl,
  decodeProduceDeliverableControl,
  decodeSelectCurrentWorkControl,
  decodeUpdatePlanControl,
} from "./control-decode-work.js";
import type {
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

const CONTROL_TOOL_NAMES = new Map<string, string>([
  ["wait", "wait"],
  ["assign_work", "assign_work"],
  ["list_workspaces", "list_workspaces"],
  ["read_workspace", "read_workspace"],
  ["accept_result", "accept_result"],
  ["send_message", "send_message"],
  ["claim_completion", "claim_completion"],
  ["update_plan", "update_plan"],
  ["select_current_work", "select_current_work"],
  ["propose_workspace", "propose_workspace"],
  ["spawn_specialist", "spawn_specialist"],
  ["declare_dependency", "declare_dependency"],
  ["produce_deliverable", "produce_deliverable"],
  ["deliver", "deliver"],
  ["record_verification_evidence", "record_verification_evidence"],
  ["conclude_verification", "conclude_verification"],
  // Existing manifests bind these aliases by version/hash. They are accepted
  // only for replay and are never included in a new model tool surface.
  ["arbor_wait", "wait"],
  ["arbor_send_message", "send_message"],
  ["arbor_claim_completion", "claim_completion"],
  ["arbor_propose_child_workspace", "propose_workspace"],
  ["arbor_spawn_specialist", "spawn_specialist"],
  ["arbor_declare_dependency", "declare_dependency"],
  ["arbor_record_verification_evidence", "record_verification_evidence"],
  ["arbor_conclude_verification", "conclude_verification"],
]);

export const decodeControlInvocation = (
  invocation: ToolInvocation,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    const modelName = CONTROL_TOOL_NAMES.get(invocation.toolName);
    if (modelName === undefined) {
      return yield* Effect.fail<ControlToolDecodeError>({
        _tag: "UnknownControlTool",
        toolName: invocation.toolName,
      });
    }
    const normalized = { ...invocation, toolName: modelName };
    const object = yield* parseControlObject(normalized);
    switch (modelName) {
      case "wait":
        return yield* decodeWaitControl(invocation, object);
      case "assign_work":
        return yield* decodeAssignWorkControl(invocation, object);
      case "list_workspaces":
        return yield* decodeListWorkspacesControl(invocation, object);
      case "read_workspace":
        return yield* decodeReadWorkspaceControl(invocation, object);
      case "accept_result":
        return yield* decodeAcceptResultControl(invocation, object);
      case "send_message":
        return yield* decodeSendMessageControl(invocation, object);
      case "claim_completion":
        return yield* decodeClaimCompletionControl(invocation, object);
      case "update_plan":
        return yield* decodeUpdatePlanControl(invocation, object);
      case "select_current_work":
        return yield* decodeSelectCurrentWorkControl(invocation, object);
      case "propose_workspace":
        return yield* decodeProposeChildWorkspaceControl(invocation, object);
      case "spawn_specialist":
        return yield* decodeSpawnSpecialistControl(invocation, object);
      case "declare_dependency":
        return yield* decodeDeclareDependencyControl(invocation, object);
      case "produce_deliverable":
        return yield* decodeProduceDeliverableControl(invocation, object);
      case "deliver":
        return yield* decodeDeliverControl(invocation, object);
      case "record_verification_evidence":
        return yield* decodeRecordVerificationEvidenceControl(
          invocation,
          object,
        );
      case "conclude_verification":
        return yield* decodeConcludeVerificationControl(invocation, object);
      default:
        return yield* Effect.fail<ControlToolDecodeError>({
          _tag: "UnknownControlTool",
          toolName: invocation.toolName,
        });
    }
  });
