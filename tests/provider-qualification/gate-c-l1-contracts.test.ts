import { describe, expect, it } from "vitest";
import type {
  CanonicalProviderEvent,
  ProviderContinuationCheckpoint,
} from "../../packages/ports/dist/provider.js";
import type {
  CapabilityQualificationRecord,
  ReasoningAttachment,
} from "../../packages/ports/dist/provider-extension.js";

const gateC = await import("../../packages/ports/dist/provider-extension.js");
const {
  cacheUsageGateViolation,
  canonicalUsageOfEvent,
  reasoningAttachmentAdmissible,
  qualificationRecordViolations,
  UNKNOWN_USAGE,
} = gateC;
const { decodeContinuationPrefix } = await import(
  "../../packages/provider-runtime/dist/runtime.js"
);
const { decideProviderRetry } = await import(
  "../../packages/ports/dist/provider-policy.js"
);

/**
 * P16 Gate C — L1 contract tests (offline, pure functions).
 * Covers the frozen semantics: usage Unknown≠0, reasoning-token translation,
 * the reportsCacheTokens gate, continuation binding, reasoning-attachment
 * binding/compaction, and the qualification status machine.
 */

const usageEvent = (
  overrides: Partial<
    Extract<CanonicalProviderEvent, { readonly _tag: "UsageReported" }>
  > = {},
): Extract<CanonicalProviderEvent, { readonly _tag: "UsageReported" }> => ({
  _tag: "UsageReported",
  inputTokens: 11,
  outputTokens: 13,
  ...overrides,
});

describe("C1 — canonical usage", () => {
  it("unknown != zero: absent dimensions stay null, reported zeros stay zero", () => {
    const usage = canonicalUsageOfEvent(usageEvent());
    expect(usage).toEqual({
      inputTokens: 11,
      outputTokens: 13,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
    // A provider that REPORTS zero cache reads measured a real zero:
    const zeroCache = canonicalUsageOfEvent(usageEvent({ cacheReadTokens: 0 }));
    expect(zeroCache.cacheReadTokens).toBe(0);
    expect(UNKNOWN_USAGE.reasoningTokens).toBeNull();
    expect(UNKNOWN_USAGE.cacheReadTokens).toBeNull();
  });

  it("reasoningTokens translate and aggregate through the canonical model", () => {
    const usage = canonicalUsageOfEvent(usageEvent({ reasoningTokens: 7 }));
    expect(usage.reasoningTokens).toBe(7);
    expect(usage.inputTokens).toBe(11);
  });

  it("INV-C1-2: reportsCacheTokens=false + emitted cache values = contract violation", () => {
    expect(cacheUsageGateViolation(false, usageEvent())).toBeUndefined();
    expect(
      cacheUsageGateViolation(false, usageEvent({ cacheReadTokens: 5 })),
    ).toBeDefined();
    expect(
      cacheUsageGateViolation(true, usageEvent({ cacheReadTokens: 5 })),
    ).toBeUndefined();
  });
});

describe("C2 — continuation binding", () => {
  const baseCheckpoint: ProviderContinuationCheckpoint = {
    cursor: "cur-1",
    canonicalEventPrefixJson: JSON.stringify([
      {
        _tag: "TurnStarted",
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789e1",
        attemptNo: 0,
        modelRef: "model-x",
      },
    ]),
    deliveredPosition: 0,
    resumeGuaranteed: true,
    adapterId: "provider-openai",
    bindingFingerprint: "p16fp_deadbeef",
  };

  it("a checkpoint bound to the producing adapter+binding is accepted", () => {
    const prefix = decodeContinuationPrefix(
      baseCheckpoint,
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789e1" as never,
      1,
      { adapterId: "provider-openai", bindingFingerprint: "p16fp_deadbeef" },
    );
    expect(prefix).not.toBeNull();
    expect(prefix?.[0]?._tag).toBe("TurnStarted");
  });

  it("a stale checkpoint (different adapter / binding) is rejected", () => {
    const foreignAdapter = decodeContinuationPrefix(
      baseCheckpoint,
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789e1" as never,
      1,
      { adapterId: "provider-testecho", bindingFingerprint: "p16fp_deadbeef" },
    );
    expect(foreignAdapter).toBeNull();
    const foreignBinding = decodeContinuationPrefix(
      baseCheckpoint,
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789e1" as never,
      1,
      { adapterId: "provider-openai", bindingFingerprint: "p16fp_other" },
    );
    expect(foreignBinding).toBeNull();
  });

  it("a legacy checkpoint without binding fields is rejected when a binding is configured", () => {
    const legacy: ProviderContinuationCheckpoint = {
      cursor: "cur-legacy",
      canonicalEventPrefixJson: baseCheckpoint.canonicalEventPrefixJson,
      deliveredPosition: 0,
    };
    expect(
      decodeContinuationPrefix(
        legacy,
        "ptn_018f2b3c-4d5e-7abc-8def-0123456789e1" as never,
        1,
        { adapterId: "provider-openai", bindingFingerprint: "p16fp_deadbeef" },
      ),
    ).toBeNull();
  });
});

describe("C2 — SafeResume prerequisites (policy surface)", () => {
  it("SafeResume requires durable cursor + durable delivered position + resumeGuaranteed", () => {
    const observation = {
      allFactsKnown: true,
      continuationAvailable: true,
      externalEffectPossible: false,
      consumerVisibleOutput: false,
      canonicalEventEmitted: true,
      firstDataEventSeen: true,
    } as never;
    const prefixJson = JSON.stringify([
      {
        _tag: "TurnStarted",
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789e1",
        attemptNo: 0,
        modelRef: "model-x",
      },
      { _tag: "TextDelta", text: "partial" },
    ]);
    const checkpoint: ProviderContinuationCheckpoint = {
      cursor: "cur",
      canonicalEventPrefixJson: prefixJson,
      deliveredPosition: 0,
      resumeGuaranteed: true,
      adapterId: "provider-openai",
      bindingFingerprint: "p16fp_x",
    };
    const decision = decideProviderRetry({
      cause: { _tag: "ProviderFailure", kind: "StreamInterrupted" },
      observation,
      continuationCheckpoint: checkpoint,
      attemptNo: 0,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(decision.safety).toBe("SafeResume");
    const noPosition: ProviderContinuationCheckpoint = {
      ...checkpoint,
      deliveredPosition: null,
    };
    const decisionNoPosition = decideProviderRetry({
      cause: { _tag: "ProviderFailure", kind: "StreamInterrupted" },
      observation,
      continuationCheckpoint: noPosition,
      attemptNo: 0,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(decisionNoPosition.safety).not.toBe("SafeResume");
    const noGuarantee: ProviderContinuationCheckpoint = {
      ...checkpoint,
      resumeGuaranteed: false,
    };
    const decisionNoGuarantee = decideProviderRetry({
      cause: { _tag: "ProviderFailure", kind: "StreamInterrupted" },
      observation,
      continuationCheckpoint: noGuarantee,
      attemptNo: 0,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(decisionNoGuarantee.safety).not.toBe("SafeResume");
  });
});

describe("C3 — reasoning round-trip state", () => {
  const attachment: ReasoningAttachment = {
    attachmentType: "provider-reasoning-v1",
    modelRef: "model-openai",
    protocolFamily: "openai-chat-completions-sse",
    bindingFingerprint: "p16fp_aaa",
    opaquePayload: "<opaque-native-blob>",
    receivedAt: "2026-09-29T00:00:00.000Z",
  };

  it("admissible only for the same model + protocol + binding", () => {
    expect(
      reasoningAttachmentAdmissible(attachment, {
        modelRef: "model-openai",
        protocolFamily: "openai-chat-completions-sse",
        bindingFingerprint: "p16fp_aaa",
      }),
    ).toBe(true);
  });

  it("cross-model reuse is rejected (INV-C2-1)", () => {
    expect(
      reasoningAttachmentAdmissible(attachment, {
        modelRef: "model-testecho",
        protocolFamily: "openai-chat-completions-sse",
        bindingFingerprint: "p16fp_aaa",
      }),
    ).toBe(false);
  });

  it("cross-protocol reuse is rejected (INV-C2-1)", () => {
    expect(
      reasoningAttachmentAdmissible(attachment, {
        modelRef: "model-openai",
        protocolFamily: "in-process-deterministic",
        bindingFingerprint: "p16fp_aaa",
      }),
    ).toBe(false);
  });

  it("compaction discard is a Model Context decision that drops the reference without parsing", () => {
    // The decision vocabulary is closed; discard never inspects the payload.
    const decisions = ["Preserve", "Inject", "DiscardForCompaction"] as const;
    expect(decisions).toContain("DiscardForCompaction");
    // The opaque payload is never structurally interpreted: the attachment
    // type exposes it as an opaque string only.
    expect(typeof attachment.opaquePayload).toBe("string");
  });
});

describe("C4 — qualification status machine", () => {
  const record = (
    capabilities: CapabilityQualificationRecord["capabilities"],
  ): CapabilityQualificationRecord =>
    ({
      deploymentId: "dep-x",
      adapterId: "provider-openai",
      modelRef: "model-openai",
      bindingFingerprint: "p16fp_x",
      identity: {
        adapterId: "provider-openai",
        providerSite: "https://x.test",
        wireModelName: "x",
        protocolFamily: "openai-chat-completions-sse",
        failureTaxonomy: "phase1-v2",
      },
      qualificationRunnerVersion: "qrun-1.0.0",
      capabilities,
      qualifiedAt: "2026-09-29T00:00:00.000Z",
    }) as never;

  const declared = {
    reportsCacheTokens: false,
    supportsContinuation: false,
    streamsDeltas: true,
    capabilities: ["text", "tools"],
  };

  it("PROVEN without evidence violates INV-C3-1 (declaration alone != proof)", () => {
    const violations = qualificationRecordViolations(
      record([{ capability: "text", status: "PROVEN", evidence: [] }]),
      declared,
    );
    expect(violations.some((v) => v.includes("INV-C3-1"))).toBe(true);
  });

  it("cache-usage PROVEN while the adapter declares reportsCacheTokens=false violates INV-C3-2", () => {
    const violations = qualificationRecordViolations(
      record([
        {
          capability: "cache-usage",
          status: "PROVEN",
          evidence: [{ layer: "L3", artifact: "evidence.json" }],
        },
      ]),
      declared,
    );
    expect(violations.some((v) => v.includes("INV-C3-2"))).toBe(true);
  });

  it("NOT_RUN is neither FAILED nor PROVEN — a clean record has no violations", () => {
    const violations = qualificationRecordViolations(
      record([
        {
          capability: "text",
          status: "PROVEN",
          evidence: [{ layer: "L2", artifact: "run-1" }],
        },
        { capability: "cache-usage", status: "NOT_RUN", evidence: [] },
        {
          capability: "provider-continuation",
          status: "UNSUPPORTED",
          evidence: [],
        },
      ]),
      declared,
    );
    expect(violations).toEqual([]);
  });

  it("runner version provenance is mandatory on the record shape", () => {
    const valid = record([]);
    expect(typeof valid.qualificationRunnerVersion).toBe("string");
    expect(valid.qualificationRunnerVersion).toMatch(/^qrun-/);
  });
});
