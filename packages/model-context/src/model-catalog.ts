import type { ModelCapability, ModelCapabilityError } from "@arbor/ports";
import { ModelCapabilityPort } from "@arbor/ports";
import { Effect, Layer } from "effect";

/**
 * P12 `12` §3–§4: the model catalog / model -> adapter resolution.
 *
 * The catalog is declarative config (a `DeclarativePlugin` artifact, `01` §1):
 * no code execution, no new package edge. `modelRef` -> adapter + capability
 * resolution is deterministic Runtime (SD §6.2), never an LLM decision, and an
 * unknown `modelRef` is a typed `ModelCapabilityError` — never a silent
 * fallback to another model.
 */

export interface ModelCatalogEntry {
  readonly modelRef: string;
  /** Which `ProviderPort` adapter family serves this model; the Composition
   * Root maps it to a concrete adapter `Layer` (never auto-discovered). */
  readonly adapterId: string;
  readonly capability: ModelCapability;
  /** Usage cost only (see `04` §3); never authority. */
  readonly priceSheetVersion?: string;
}

export interface ModelCatalog {
  readonly entries: ReadonlyArray<ModelCatalogEntry>;
  /** Deterministic tie-break / default when several entries match. */
  readonly defaultModelRef: string;
}

/** Deterministic `modelRef` -> entry resolution; `undefined` = unknown. */
export const resolveModelCatalogEntry = (
  catalog: ModelCatalog,
  modelRef: string,
): ModelCatalogEntry | undefined =>
  catalog.entries.find((entry) => entry.modelRef === modelRef);

/** Unknown `modelRef` is a typed failure, never a silent fallback. */
export const resolveModelCapability = (
  catalog: ModelCatalog,
  modelRef: string,
): Effect.Effect<ModelCapability, ModelCapabilityError> => {
  const entry = resolveModelCatalogEntry(catalog, modelRef);
  if (entry === undefined) {
    return Effect.fail({
      _tag: "ModelCapabilityError",
      cause: `unknown modelRef: ${modelRef}`,
    });
  }
  return Effect.succeed(entry.capability);
};

const satisfies = (
  capability: ModelCapability,
  requiredCapabilities: ReadonlyArray<string>,
): boolean => {
  const declared = capability.capabilities ?? [];
  return requiredCapabilities.every((capability) =>
    declared.includes(capability),
  );
};

/**
 * The real `ModelCapabilityPort` (replaces the test-only static layer at the
 * Composition Root). Selection is deterministic: the default entry wins among
 * the catalogued models satisfying every required capability, otherwise the
 * first catalogued match. No match is a typed `ModelCapabilityError`.
 */
export const ModelCapabilityPortLive = (
  catalog: ModelCatalog,
): Layer.Layer<ModelCapabilityPort> =>
  Layer.succeed(ModelCapabilityPort, {
    resolve: ({ requiredCapabilities }) => {
      const candidates = catalog.entries.filter((entry) =>
        satisfies(entry.capability, requiredCapabilities),
      );
      const chosen =
        candidates.find(
          (entry) => entry.modelRef === catalog.defaultModelRef,
        ) ?? candidates[0];
      if (chosen === undefined) {
        return Effect.fail({
          _tag: "ModelCapabilityError",
          cause: "no catalogued model satisfies requiredCapabilities",
        });
      }
      return Effect.succeed(chosen.capability);
    },
  });

/** Declarative default catalog wired at the Composition Root. `model-fake`
 * keeps the deterministic CI provider; `model-openai` selects the real
 * `adapters/provider-openai` adapter when a client is injected. */
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
