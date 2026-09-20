import type { CanonicalResourceRegion } from "@arbor/domain";
import type {
  InvocationAuthority,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
} from "@arbor/ports";

/** P4 `03` §1–§3; DID v1.8 G1; SD v1.3 §8.1–§8.3. */
export type AuthorityCheck =
  | { readonly _tag: "Ok" }
  | { readonly _tag: "Denied"; readonly reason: string };

const deny = (reason: string): AuthorityCheck => ({ _tag: "Denied", reason });

export const checkInvocationAuthority = (input: {
  readonly authority: InvocationAuthority;
  readonly definition: ToolDefinition;
  readonly intent: ToolIntent;
  readonly context: ToolExecutionContext;
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  readonly now: string;
  readonly maxDelegationDepth: number;
}): AuthorityCheck => {
  const { authority, definition, intent, context, regions, now } = input;
  if (authority.principal !== context.authenticatedPrincipal) {
    return deny("principal mismatch");
  }
  if (authority.workspaceId !== context.workspaceId) {
    return deny("workspace mismatch");
  }
  if (authority.executionId !== context.executionId) {
    return deny("execution mismatch");
  }
  if (
    authority.toolName !== intent.toolName ||
    authority.toolVersion !== intent.toolVersion
  ) {
    return deny("tool mismatch");
  }
  if (authority.controlBasisDigest !== context.controlBasisDigest) {
    return deny("control basis mismatch");
  }
  if (authority.expiresAt <= now) {
    return deny("authority expired");
  }
  if (authority.delegationDepth > input.maxDelegationDepth) {
    return deny("delegation depth exceeded");
  }
  for (const region of regions) {
    if (!authority.resourceSpaceIds.includes(region.resourceSpaceId)) {
      return deny(`resource space not authorized: ${region.resourceSpaceId}`);
    }
  }
  for (const capability of definition.capabilityMetadata) {
    if (!authority.allowedCapabilities.includes(capability)) {
      return deny(`capability not allowed: ${capability}`);
    }
  }
  return { _tag: "Ok" };
};
