import { describe, expect, it } from "vitest";
import { conversationCheckpointBindingUse } from "../src/conversation-checkpoint-binding.js";

const fingerprint = `p16fp_${"a".repeat(64)}`;
const opaqueRef = "provider-native:opaque-old-state";

describe("AH19 Conversation checkpoint provider binding", () => {
  it("reuses ProviderNative only for exact binding and supported operation", () => {
    expect(
      conversationCheckpointBindingUse({
        checkpointKind: "ProviderNative",
        checkpointRef: opaqueRef,
        sourceBindingFingerprint: fingerprint,
        currentBindingFingerprint: fingerprint,
        providerNativeSupported: true,
      }),
    ).toEqual({
      _tag: "ProviderNative",
      opaqueItemRef: opaqueRef,
      bindingFingerprint: fingerprint,
    });
  });

  it.each([
    ["binding mismatch", `p16fp_${"b".repeat(64)}`, true],
    ["unsupported native operation", fingerprint, false],
    ["missing opaque ref", fingerprint, true],
  ])(
    "rebases %s as Portable Summary without carrying the opaque ref",
    (_name, sourceBindingFingerprint, supported) => {
      const result = conversationCheckpointBindingUse({
        checkpointKind: "ProviderNative",
        checkpointRef: _name === "missing opaque ref" ? null : opaqueRef,
        sourceBindingFingerprint,
        currentBindingFingerprint: fingerprint,
        providerNativeSupported: supported,
      });
      expect(result).toEqual({ _tag: "PortableSummary" });
      expect(JSON.stringify(result)).not.toContain(opaqueRef);
    },
  );
});
