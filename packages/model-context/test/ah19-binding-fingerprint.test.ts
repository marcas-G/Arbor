import {
  ContextEpochNumber,
  ExecutionId,
  executionBound,
  ProviderTurnId,
  parse,
  SessionId,
} from "@arbor/domain";
import {
  ModelCapabilityPort,
  type ModelCatalog,
  type ModelDeployment,
  makeProviderRegistry,
  type ProtocolAdapter,
  type ProviderPort,
  type ResolvedModelBinding,
  resolvedModelBindingFingerprint,
  resolveModelBinding,
  secretRef,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { compileTurn, type ModelContextPlan } from "../src/compiler.js";
import {
  DEFAULT_MODEL_CATALOG,
  ModelCapabilityPortLive,
} from "../src/model-catalog.js";

const nativeOperations = [
  "Inference",
  "CompactionSummary",
  "CompactionNative",
] as const;

const nativeCatalog: ModelCatalog = {
  defaultModelRef: "model-ah19",
  entries: [
    {
      modelRef: "model-ah19",
      adapterId: "provider-ah19",
      capability: {
        modelRef: "model-ah19",
        family: "ah19-test",
        contextWindow: 32_000,
        outputCeiling: 2_000,
        toolProtocol: "json",
        portableRequestCompatibility: {
          operationKinds: nativeOperations,
          inputItemKinds: ["Message", "CompactionCheckpoint"],
        },
      },
    },
  ],
};
const nativeProfile = nativeCatalog.entries[0];
if (nativeProfile === undefined) throw new Error("AH19 native profile missing");

const adapter: ProtocolAdapter = {
  adapterId: "provider-ah19",
  profile: {
    protocolFamily: "openai-chat-completions-sse",
    authMode: { _tag: "BearerSecret" },
    capabilityFlags: {
      reportsCacheTokens: false,
      supportsContinuation: true,
      streamsDeltas: true,
    },
    failureTaxonomy: "phase1-v2",
  },
  layerFor: () => Layer.empty as unknown as Layer.Layer<ProviderPort>,
};

const registry = makeProviderRegistry([adapter]);

const plan: ModelContextPlan = {
  instructions: {
    effective: [],
    suppressed: [],
    conflicts: [],
    governanceIssues: [],
  },
  context: [],
  tools: [],
  skills: [],
  outputContract: "agent-directive-v1",
  continuation: "recent-frontier",
  controlBasis: {
    projectPolicyRevision: 0,
    workspacePolicyRevision: 0,
    responsibilityRevision: 0,
    resourceBoundaryRevision: 0,
    authorizationDigest: "ah19-test-digest",
    environmentRevision: "ah19-test-environment",
  },
};

const resolveBinding = (
  overrides: Partial<ModelDeployment> = {},
): ResolvedModelBinding => {
  const resolved = resolveModelBinding(registry, nativeCatalog, {
    deploymentId: "dep-ah19",
    modelRef: "model-ah19",
    endpoint: "https://provider.example/v1",
    wireModelName: "wire-ah19",
    secretRef: secretRef("AH19_SECRET_REF_SENTINEL"),
    ...overrides,
  });
  if ("_tag" in resolved) throw new Error(JSON.stringify(resolved));
  return resolved;
};

const resolveCapability = (bindingFingerprint?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const capabilityPort = yield* ModelCapabilityPort;
      return yield* capabilityPort.resolve({
        binding: executionBound("AH19 capability qualification"),
        cognitiveMode: "work",
        requiredCapabilities: [],
      });
    }).pipe(
      Effect.provide(
        ModelCapabilityPortLive(
          nativeCatalog,
          "model-ah19",
          bindingFingerprint,
        ),
      ),
    ),
  );

describe("AH19 full binding fingerprint propagation", () => {
  it("is stable for the same resolved deployment and changes with endpoint, deployment, model, or policy", () => {
    const baseline = resolveModelBinding(registry, nativeCatalog, {
      deploymentId: "dep-ah19",
      modelRef: "model-ah19",
      endpoint: "https://provider.example/v1",
      wireModelName: "wire-ah19",
      secretRef: secretRef("AH19_SECRET_REF_SENTINEL"),
    });
    if ("_tag" in baseline) throw new Error(JSON.stringify(baseline));
    const fingerprint = resolvedModelBindingFingerprint(baseline);

    expect(resolvedModelBindingFingerprint(resolveBinding())).toBe(fingerprint);
    expect(
      resolvedModelBindingFingerprint(
        resolveBinding({ endpoint: "https://other.example/v1" }),
      ),
    ).not.toBe(fingerprint);
    expect(
      resolvedModelBindingFingerprint(
        resolveBinding({ deploymentId: "dep-ah19-next" }),
      ),
    ).not.toBe(fingerprint);
    const secondModelCatalog: ModelCatalog = {
      ...nativeCatalog,
      entries: [
        ...nativeCatalog.entries,
        {
          ...nativeProfile,
          modelRef: "model-ah19-other",
          capability: {
            ...nativeProfile.capability,
            modelRef: "model-ah19-other",
          },
        },
      ],
    };
    const secondModel = resolveModelBinding(registry, secondModelCatalog, {
      deploymentId: "dep-ah19",
      modelRef: "model-ah19-other",
      endpoint: "https://provider.example/v1",
      wireModelName: "wire-ah19",
      secretRef: secretRef("AH19_SECRET_REF_SENTINEL"),
    });
    if ("_tag" in secondModel) throw new Error(JSON.stringify(secondModel));
    expect(resolvedModelBindingFingerprint(secondModel)).not.toBe(fingerprint);
    expect(
      resolvedModelBindingFingerprint(
        resolveBinding({ executionPolicyOverrides: { maxAttempts: 2 } }),
      ),
    ).not.toBe(fingerprint);
    expect(
      resolvedModelBindingFingerprint(
        resolveBinding({ secretRef: secretRef("OTHER_SECRET_REF_SENTINEL") }),
      ),
    ).toBe(fingerprint);
  });

  it("propagates a complete deployment fingerprint and strips Native when the binding is absent", async () => {
    const resolved = resolveBinding();
    const fingerprint = resolvedModelBindingFingerprint(resolved);
    const bound = await resolveCapability(fingerprint);
    expect(bound.bindingFingerprint).toBe(fingerprint);
    expect(bound.portableRequestCompatibility?.operationKinds).toContain(
      "CompactionNative",
    );

    const unbound = await resolveCapability();
    expect(unbound.bindingFingerprint).toBeUndefined();
    expect(unbound.portableRequestCompatibility?.operationKinds).not.toContain(
      "CompactionNative",
    );

    const incomplete = await resolveCapability(
      "legacy:provider-ah19:model-ah19",
    );
    expect(incomplete.bindingFingerprint).toBeUndefined();
    expect(
      incomplete.portableRequestCompatibility?.operationKinds,
    ).not.toContain("CompactionNative");
  });

  it("does not place secret references or material in capability metadata", async () => {
    const fingerprint = resolvedModelBindingFingerprint(resolveBinding());
    const capability = await resolveCapability(fingerprint);
    const serialized = JSON.stringify({ capability, fingerprint });
    expect(serialized).not.toContain("AH19_SECRET_REF_SENTINEL");
    expect(serialized).not.toContain("AH19_SECRET_MATERIAL_SENTINEL");
    expect(serialized).not.toContain("secretRef");
  });

  it("writes the capability fingerprint into the ModelContext Manifest without secret fields", async () => {
    const fingerprint = resolvedModelBindingFingerprint(resolveBinding());
    const capability = await resolveCapability(fingerprint);
    const prepared = compileTurn({
      plan,
      capability,
      providerTurnId: parse(ProviderTurnId)(
        "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
      ),
      executionId: parse(ExecutionId)(
        "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
      ),
      sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
      contextEpoch: parse(ContextEpochNumber)(0),
      maxOutputTokens: 256,
      stepContext: {
        logicalStepNo: 0,
        repairAttempt: 0,
        inputFrontier: { firstSequence: null, lastSequence: null },
        fingerprint: "ah19-step-context-fingerprint",
        bindingFingerprint: capability.bindingFingerprint ?? "",
      },
    });
    const manifestJson = JSON.stringify(prepared.manifest);
    expect(prepared.manifest.resolvedModelBindingFingerprint).toBe(fingerprint);
    expect(manifestJson).not.toContain("AH19_SECRET_REF_SENTINEL");
    expect(manifestJson).not.toContain("AH19_SECRET_MATERIAL_SENTINEL");
    expect(manifestJson).not.toContain("secretRef");
  });

  it("does not declare ProviderNative for the current stock model catalog", () => {
    for (const profile of DEFAULT_MODEL_CATALOG.entries) {
      expect(
        profile.capability.portableRequestCompatibility?.operationKinds ?? [],
      ).not.toContain("CompactionNative");
    }
  });
});
