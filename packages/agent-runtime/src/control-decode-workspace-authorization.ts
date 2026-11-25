import { decodeNetworkPolicyV1, isIsoTimestamp } from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import {
  hasOnlyControlFields,
  invalidControlArguments,
} from "./control-decode-shared.js";
import type {
  ControlToolDecodeError,
  ControlToolInvocation,
} from "./control-types.js";

export const decodeAllocateWorkspaceSandboxControl = (
  invocation: ToolInvocation,
  object: Record<string, unknown>,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> => {
  const networkPolicy = decodeNetworkPolicyV1(object.networkPolicy);
  if (
    !hasOnlyControlFields(object, [
      "targetWorkspaceRef",
      "profile",
      "networkPolicy",
      "expiresAt",
    ]) ||
    typeof object.targetWorkspaceRef !== "string" ||
    !object.targetWorkspaceRef.startsWith("wref_") ||
    object.targetWorkspaceRef.length > 256 ||
    (object.profile !== "ReadOnly" && object.profile !== "WorkspaceWrite") ||
    networkPolicy === undefined ||
    !(
      object.expiresAt === null ||
      (typeof object.expiresAt === "string" && isIsoTimestamp(object.expiresAt))
    )
  )
    return invalidControlArguments(
      invocation.toolName,
      "Allocation requires an exact direct-child ref, bounded profile, canonical network policy and explicit expiry or null; identities and source revisions are Runtime-bound",
    );
  return Effect.succeed({
    invocation,
    action: {
      _tag: "AllocateWorkspaceSandbox",
      targetWorkspaceRef: object.targetWorkspaceRef,
      profile: object.profile,
      networkPolicy,
      expiresAt: object.expiresAt,
    },
  });
};
