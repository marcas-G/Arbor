import type { ModelCatalog } from "@arbor/ports";

/**
 * P16 `01` §4 — the declarative default model catalog (Whitelisted data
 * file, P16 `02` §0 WL). Entries are pure data; adding a compatible-provider
 * model under an existing protocol family happens here without touching any
 * core or adapter code (E4a).
 */
export const DEFAULT_MODEL_CATALOG: ModelCatalog = {
  defaultModelRef: "model-fake",
  entries: [
    {
      modelRef: "model-fake",
      adapterId: "provider-fake",
      capability: {
        modelRef: "model-fake",
        family: "fake",
        contextWindow: 8000,
        outputCeiling: 512,
        toolProtocol: "json",
        capabilities: ["text", "tools"],
      },
    },
    {
      modelRef: "model-openai",
      adapterId: "provider-openai",
      capability: {
        modelRef: "model-openai",
        family: "openai",
        contextWindow: 128000,
        outputCeiling: 4096,
        toolProtocol: "json",
        capabilities: ["text", "tools"],
      },
      priceSheetVersion: "openai-2026-01",
    },
    {
      // P16 E4a proof-of-construction: a compatible provider under the
      // EXISTING openai-chat-completions-sse family is pure catalog data +
      // a deployment fixture + qualification evidence — zero core/adapter
      // code (verify-provider-extension.mjs --mode compatible proves it).
      modelRef: "model-openai-compat-echo",
      adapterId: "provider-openai",
      capability: {
        modelRef: "model-openai-compat-echo",
        family: "openai-compat",
        contextWindow: 64000,
        outputCeiling: 2048,
        toolProtocol: "json",
        capabilities: ["text", "tools"],
      },
      knownDeployments: ["dep-openai-compat-echo"],
    },
    {
      // P16 E4b proof-of-construction: a NEW protocol family (in-process
      // deterministic echo) onboarded as catalog data + adapter package +
      // registry line — no core change (verify --mode protocol proves it).
      modelRef: "model-testecho",
      adapterId: "provider-testecho",
      capability: {
        modelRef: "model-testecho",
        family: "testecho",
        contextWindow: 2000,
        outputCeiling: 256,
        toolProtocol: "json",
        capabilities: ["text"],
      },
    },
  ],
};
