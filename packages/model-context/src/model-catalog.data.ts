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
  ],
};
