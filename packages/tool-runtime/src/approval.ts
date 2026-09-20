import type { CanonicalResourceRegion } from "@arbor/domain";
import type {
  InvocationApproval,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
} from "@arbor/ports";

/** P4 `03` §4; DID v1.8 G2; SD v1.3 §8.4. */

export type ApprovalCheck =
  | { readonly _tag: "Ok" }
  | { readonly _tag: "Denied"; readonly reason: string };

const fnv = (input: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

/** Normalized action + params digest bound by an approval. */
export const actionDigestOf = (intent: ToolIntent): string =>
  fnv(`${intent.toolName}@${intent.toolVersion}:${intent.argumentsJson}`);

export const matchApproval = (input: {
  readonly approval: InvocationApproval;
  readonly intent: ToolIntent;
  readonly definition: ToolDefinition;
  readonly context: ToolExecutionContext;
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  readonly now: string;
}): ApprovalCheck => {
  const { approval, intent, definition, context, regions, now } = input;
  if (approval.consumedBy !== null) {
    return { _tag: "Denied", reason: "approval already consumed" };
  }
  if (
    approval.toolName !== intent.toolName ||
    approval.toolVersion !== definition.version
  ) {
    return { _tag: "Denied", reason: "approval tool mismatch" };
  }
  if (approval.actionDigest !== actionDigestOf(intent)) {
    return { _tag: "Denied", reason: "approval action digest mismatch" };
  }
  if (approval.controlBasisDigest !== context.controlBasisDigest) {
    return { _tag: "Denied", reason: "approval control basis mismatch" };
  }
  if (approval.expiresAt <= now) {
    return { _tag: "Denied", reason: "approval expired" };
  }
  for (const region of regions) {
    if (!approval.targetResourceSpaceIds.includes(region.resourceSpaceId)) {
      return { _tag: "Denied", reason: "approval target mismatch" };
    }
  }
  return { _tag: "Ok" };
};
