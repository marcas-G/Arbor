const load = async (specifier) => {
  try {
    return await import(specifier);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ tag: "AH19_IMPORT_ERROR", specifier, message: String(error), stack: error?.stack })}\n`,
    );
    throw error;
  }
};

const [ports, effect, composition, app] = await Promise.all([
  load("../../../packages/ports/dist/index.js"),
  load("effect"),
  load("../../../apps/single-workspace/dist/composition.js"),
  load("../../../apps/single-workspace/dist/main.js"),
]);
const { ProviderPort } = ports;
const { resolvedModelBindingFingerprint, resolveModelBinding } = ports;
const { Effect, Layer, Stream } = effect;
const { providerRegistry } = composition;
const { main, runDaemonForever } = app;

process.on("uncaughtException", (error) => {
  process.stdout.write(
    `${JSON.stringify({ tag: "AH19_CHILD_ERROR", message: String(error), stack: error?.stack })}\n`,
  );
  process.exitCode = 1;
});
process.on("unhandledRejection", (error) => {
  process.stdout.write(
    `${JSON.stringify({ tag: "AH19_CHILD_ERROR", message: String(error), stack: error?.stack })}\n`,
  );
  process.exitCode = 1;
});
if (process.env.ARBOR_AH19_CAPTURE_EXIT === "1") {
  process.on("exit", (exitCode) => {
    process.stdout.write(
      `${JSON.stringify({ tag: "AH19_CHILD_EXIT", exitCode })}\n`,
    );
  });
}
process.stdout.write(
  `${JSON.stringify({ tag: "AH19_CHILD_START", pid: process.pid })}\n`,
);
const modelRef = "model-ah19-native-test";
const adapterId = "provider-ah19-native-test";
const variant = process.env.ARBOR_AH19_BINDING_VARIANT ?? "A";
const endpoint = `test://native-binding-${variant.toLowerCase()}`;
const reportUrl = process.env.ARBOR_AH19_REPORT_URL;
const targetBoundary = process.env.ARBOR_AH19_BOUNDARY;
const gateTurnSuffix = process.env.ARBOR_AH19_GATE_TURN_SUFFIX;
const nestedNativeMode = process.env.ARBOR_AH19_NESTED_NATIVE === "1";
const terminalConversationMode =
  process.env.ARBOR_AH19_TERMINAL_CONVERSATION === "1";
let ah11AfterEffectsCount = 0;
const boundaries = new Set([
  "AH17BeforeCheckpointEpochCommit",
  "AH17AfterCheckpointEpochCommit",
  "AH12BeforeSuccessCommit",
  "AH11AfterStepEffectsCommit",
]);
if (reportUrl === undefined) throw new Error("AH19 report endpoint required");
if (targetBoundary !== "none" && !boundaries.has(targetBoundary)) {
  throw new Error("AH19 child needs an exact checkpoint commit boundary");
}

const report = async (event) => {
  const response = await fetch(reportUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    throw new Error(`AH19 report endpoint returned ${response.status}`);
  }
};

const started = (request, context) => [
  {
    _tag: "Observation",
    delta: { responseStarted: true, externalEffectPossible: false },
  },
  {
    _tag: "Canonical",
    event: {
      _tag: "TurnStarted",
      providerTurnId: context.providerTurnId,
      attemptNo: context.attemptNo,
      modelRef: request.modelRef,
    },
  },
];

const nativeAdapter = {
  adapterId,
  profile: {
    protocolFamily: "in-process-deterministic",
    authMode: { _tag: "None" },
    capabilityFlags: {
      reportsCacheTokens: false,
      supportsContinuation: true,
      streamsDeltas: true,
    },
    failureTaxonomy: "phase1-v2",
  },
  layerFor: () =>
    Layer.succeed(
      ProviderPort,
      ProviderPort.of({
        runTurn: ({ request, context }) => {
          const operationKind = request.operationKind ?? "Inference";
          const providerTurnId = String(context.providerTurnId);
          const continuation = request.inputItems.find(
            (item) => item._tag === "CompactionCheckpoint",
          );
          const requestSummary = {
            event: "AH19_PROVIDER_REQUEST",
            operationKind,
            providerTurnId: context.providerTurnId,
            bindingVariant: variant,
            items: request.inputItems.map((item) =>
              item._tag === "CompactionCheckpoint"
                ? {
                    _tag: item._tag,
                    implementation: item.implementation,
                    bindingFingerprint: item.bindingFingerprint,
                    opaqueItemRef: item.opaqueItemRef,
                  }
                : { _tag: item._tag },
            ),
          };
          const beforeStream = Stream.fromEffect(
            Effect.promise(() => report(requestSummary)),
          );
          if (operationKind === "CompactionNative") {
            return Stream.flatMap(beforeStream, () =>
              Stream.fromIterable([
                ...started(request, context),
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "ContinuationState",
                    stateRef: `ah19-opaque:${context.providerTurnId}`,
                  },
                },
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "TurnCompleted",
                    finishReason: "Stop",
                  },
                },
              ]),
            );
          }
          if (
            operationKind === "Inference" &&
            /_0$/u.test(providerTurnId) &&
            !providerTurnId.includes("_overflow_")
          ) {
            if (terminalConversationMode) {
              return Stream.flatMap(beforeStream, () =>
                Stream.concat(
                  Stream.fromIterable(started(request, context)),
                  Stream.fail({
                    _tag: "ProviderFailure",
                    kind: "ContextLimitExceeded",
                    taxonomyVersion: "phase1-v2",
                    safeDiagnostic: "AH19 controlled terminal ContextLimit",
                  }),
                ),
              );
            }
            const callRef = `call_ah19_plan_${providerTurnId.replaceAll(/[^a-zA-Z0-9]/gu, "_")}`;
            return Stream.flatMap(beforeStream, () =>
              Stream.fromIterable([
                ...started(request, context),
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "ToolCallProposed",
                    callRef,
                    toolName: "update_plan",
                    argumentsJson: JSON.stringify({
                      items: [
                        {
                          itemId: "preserve-portable-frontier",
                          text: "Preserve the portable Session frontier for AH19.",
                          status: "Pending",
                        },
                      ],
                    }),
                  },
                },
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "TurnCompleted",
                    finishReason: "ToolCalls",
                  },
                },
              ]),
            );
          }
          if (operationKind === "CompactionSummary") {
            return Stream.flatMap(beforeStream, () =>
              Stream.fromIterable([
                ...started(request, context),
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "TextDelta",
                    text: `Portable AH19 continuation ${variant}.`,
                  },
                },
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "TurnCompleted",
                    finishReason: "Stop",
                  },
                },
              ]),
            );
          }
          if (
            terminalConversationMode &&
            operationKind === "Inference" &&
            providerTurnId.includes("_overflow_")
          ) {
            return Stream.flatMap(beforeStream, () =>
              Stream.fromIterable([
                ...started(request, context),
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "TextDelta",
                    text: "AH19 recovered terminal conversation answer.",
                  },
                },
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "TurnCompleted",
                    finishReason: "Stop",
                  },
                },
              ]),
            );
          }
          if (
            nestedNativeMode &&
            operationKind === "Inference" &&
            providerTurnId.includes("_overflow_")
          ) {
            const callRef = `call_ah19_plan_${providerTurnId.replaceAll(/[^a-zA-Z0-9]/gu, "_")}`;
            return Stream.flatMap(beforeStream, () =>
              Stream.fromIterable([
                ...started(request, context),
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "ToolCallProposed",
                    callRef,
                    toolName: "update_plan",
                    argumentsJson: JSON.stringify({
                      items: [
                        {
                          itemId: "preserve-portable-frontier",
                          text: "Preserve the portable Session frontier for AH19.",
                          status: "Pending",
                        },
                      ],
                    }),
                  },
                },
                {
                  _tag: "Canonical",
                  event: {
                    _tag: "TurnCompleted",
                    finishReason: "ToolCalls",
                  },
                },
              ]),
            );
          }
          if (
            operationKind === "Inference" &&
            (/_1$/u.test(providerTurnId) ||
              (nestedNativeMode && /_2$/u.test(providerTurnId))) &&
            (continuation === undefined ||
              (nestedNativeMode && /_2$/u.test(providerTurnId))) &&
            !request.inputItems.some(
              (item) =>
                item._tag === "Message" &&
                item.text.includes("[Continuation checkpoint]"),
            )
          ) {
            return Stream.flatMap(beforeStream, () =>
              Stream.concat(
                Stream.fromIterable(started(request, context)),
                Stream.fail({
                  _tag: "ProviderFailure",
                  kind: "ContextLimitExceeded",
                  taxonomyVersion: "phase1-v2",
                  safeDiagnostic: "AH19 controlled initial ContextLimit",
                }),
              ),
            );
          }
          const callRef = `call_ah19_${String(context.providerTurnId).replaceAll(/[^a-zA-Z0-9]/gu, "_")}`;
          return Stream.flatMap(beforeStream, () =>
            Stream.fromIterable([
              ...started(request, context),
              {
                _tag: "Canonical",
                event: {
                  _tag: "ToolCallProposed",
                  callRef,
                  toolName: "wait",
                  argumentsJson: JSON.stringify({
                    reason: "complete AH19 process qualification",
                    waitSpec: {
                      mode: "Any",
                      conditions: [{ _tag: "Manual" }],
                    },
                  }),
                },
              },
              {
                _tag: "Canonical",
                event: {
                  _tag: "TurnCompleted",
                  finishReason: "ToolCalls",
                },
              },
            ]),
          );
        },
      }),
    ),
};

// This adapter lives only in the isolated test daemon process. The stock
// OpenAI/fake/testecho registrations and their capability declarations remain
// untouched.
providerRegistry.adapters.push(nativeAdapter);

const modelCatalog = {
  defaultModelRef: modelRef,
  entries: [
    {
      modelRef,
      adapterId,
      capability: {
        modelRef,
        family: "ah19-native-test",
        contextWindow: 16_384,
        outputCeiling: 1_024,
        toolProtocol: "json",
        capabilities: ["text", "tools"],
        portableRequestCompatibility: {
          operationKinds: [
            "Inference",
            "CompactionSummary",
            "CompactionNative",
          ],
          inputItemKinds: ["Message", "ToolCall", "CompactionCheckpoint"],
        },
      },
    },
  ],
};

const config = {
  tickIntervalMs: 25,
  secretRef: undefined,
  modelCatalog,
  modelRef,
  deployment: {
    deploymentId: "dep-ah19-native-test",
    modelRef,
    endpoint,
  },
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port: Number(process.env.ARBOR_HTTP_PORT),
    host: "127.0.0.1",
  },
  qualificationProbe: async (event) => {
    if (event.boundary === "AH19NativeCheckpointRecovery") {
      process.stdout.write(
        `${JSON.stringify({ tag: "AH19_PROBE", ...event })}\n`,
      );
      return;
    }
    if (targetBoundary === "none" || event.boundary !== targetBoundary) {
      return;
    }
    const stepEffectsBoundary = targetBoundary === "AH11AfterStepEffectsCommit";
    if (stepEffectsBoundary) {
      ah11AfterEffectsCount += 1;
      const gateMatchIndex = Number(
        process.env.ARBOR_AH19_AH11_MATCH_INDEX ?? "2",
      );
      if (ah11AfterEffectsCount !== gateMatchIndex) return;
    }
    if (
      stepEffectsBoundary
        ? gateTurnSuffix !== undefined &&
          !String(event.providerTurnId).endsWith(gateTurnSuffix)
        : !String(event.providerTurnId).includes("_native_compact_") ||
          (gateTurnSuffix !== undefined &&
            !String(event.providerTurnId).endsWith(gateTurnSuffix))
    ) {
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ tag: "AH19_PROBE", ...event })}\n`,
    );
    await new Promise(() => {});
  },
  providerQualificationProbe: async (event) => {
    if (
      targetBoundary === "none" ||
      event.boundary !== targetBoundary ||
      !String(event.providerTurnId).includes("_native_compact_") ||
      (gateTurnSuffix !== undefined &&
        !String(event.providerTurnId).endsWith(gateTurnSuffix))
    ) {
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ tag: "AH19_PROBE", ...event })}\n`,
    );
    await new Promise(() => {});
  },
};

const resolvedTestBinding = resolveModelBinding(
  providerRegistry,
  modelCatalog,
  config.deployment,
);
if ("_tag" in resolvedTestBinding) {
  throw new Error(
    `AH19 test binding resolution failed: ${resolvedTestBinding._tag}`,
  );
}
process.stdout.write(
  `${JSON.stringify({
    tag: "AH19_CHILD_BINDING",
    variant,
    endpoint,
    bindingFingerprint: resolvedModelBindingFingerprint(resolvedTestBinding),
  })}\n`,
);

try {
  await Effect.runPromise(
    Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ tag: "AH19_CHILD_ERROR", message: String(error), stack: error?.stack, error: typeof error === "object" && error !== null ? Object.fromEntries(Object.entries(error)) : error })}\n`,
  );
  process.exitCode = 1;
}
