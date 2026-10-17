import type { ConversationCheckpointOwner } from "@arbor/ports";

export type ConversationCheckpointBindingUse =
  | { readonly _tag: "PortableSummary" }
  | {
      readonly _tag: "ProviderNative";
      readonly opaqueItemRef: string;
      readonly bindingFingerprint: string;
    };

/** A ProviderNative ref is reusable only for its exact complete binding and
 * when the current provider advertises that operation. Every other case rebases
 * from canonical public Job/HumanMessage facts and never forwards the ref. */
export const conversationCheckpointBindingUse = (input: {
  readonly checkpointKind: ConversationCheckpointOwner["checkpointKind"];
  readonly checkpointRef: string | null;
  readonly sourceBindingFingerprint: string | null;
  readonly currentBindingFingerprint: string;
  readonly providerNativeSupported: boolean;
}): ConversationCheckpointBindingUse => {
  if (
    input.checkpointKind === "ProviderNative" &&
    input.checkpointRef !== null &&
    input.checkpointRef.length > 0 &&
    input.sourceBindingFingerprint !== null &&
    input.sourceBindingFingerprint === input.currentBindingFingerprint &&
    input.providerNativeSupported
  ) {
    return {
      _tag: "ProviderNative",
      opaqueItemRef: input.checkpointRef,
      bindingFingerprint: input.sourceBindingFingerprint,
    };
  }
  return { _tag: "PortableSummary" };
};
