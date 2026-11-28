import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_CATALOG } from "../src/model-catalog.data.js";
import { resolveModelCatalogEntry } from "../src/model-catalog.js";

describe("default provider model catalog", () => {
  it.each([
    ["model-deepseek-compatible", "deepseek-compatible"],
    ["model-qwen-compatible", "qwen-compatible"],
    ["model-openrouter-compatible", "openrouter-compatible"],
  ])(
    "%s is an explicit OpenAI-compatible deployment profile",
    (modelRef, family) => {
      const entry = resolveModelCatalogEntry(DEFAULT_MODEL_CATALOG, modelRef);
      expect(entry).toMatchObject({
        modelRef,
        adapterId: "provider-openai",
        capability: {
          family,
          capabilities: ["text", "tools"],
        },
      });
      expect(entry?.capability.capabilities).not.toContain("reasoning");
    },
  );
});
