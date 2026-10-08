import type {
  ModelCapability,
  ModelCapabilityError,
  ModelCatalog,
  ModelProfile,
} from "@arbor/ports";

export type { ModelCatalog };

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

/** P16 `01` §4: the catalog entry IS the frozen `ModelProfile`. */
export type ModelCatalogEntry = ModelProfile;

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

const isCompleteBindingFingerprint = (
  value: string | undefined,
): value is string => value !== undefined && /^p16fp_[0-9a-f]{64}$/.test(value);

const withoutCatalogBindingFingerprint = (
  capability: ModelCapability,
): Omit<ModelCapability, "bindingFingerprint"> => {
  const result = { ...capability };
  delete result.bindingFingerprint;
  return result;
};

/**
 * The real `ModelCapabilityPort` (replaces the test-only static layer at the
 * Composition Root). Selection is deterministic: the default entry wins among
 * the catalogued models satisfying every required capability, otherwise the
 * first catalogued match. No match is a typed `ModelCapabilityError`.
 */
export const ModelCapabilityPortLive = (
  catalog: ModelCatalog,
  /** Composition-selected modelRef (the configured deployment's model).
   * When given it takes precedence over the catalog default — the catalog
   * default stays the CI fake unless a real deployment is bound. */
  preferredModelRef?: string,
  /** Full Composition-Root ResolvedModelBinding fingerprint. Without this
   * complete identity ProviderNative compatibility is withheld fail-closed. */
  bindingFingerprint?: string,
): Layer.Layer<ModelCapabilityPort> =>
  Layer.succeed(ModelCapabilityPort, {
    resolve: ({ requiredCapabilities }) => {
      const candidates = catalog.entries.filter((entry) =>
        satisfies(entry.capability, requiredCapabilities),
      );
      const chosen =
        (preferredModelRef !== undefined
          ? candidates.find((entry) => entry.modelRef === preferredModelRef)
          : undefined) ??
        candidates.find(
          (entry) => entry.modelRef === catalog.defaultModelRef,
        ) ??
        candidates[0];
      if (chosen === undefined) {
        return Effect.fail({
          _tag: "ModelCapabilityError",
          cause: "no catalogued model satisfies requiredCapabilities",
        });
      }
      const completeBindingFingerprint =
        isCompleteBindingFingerprint(bindingFingerprint);
      const declaredCompatibility =
        chosen.capability.portableRequestCompatibility;
      const portableRequestCompatibility =
        !completeBindingFingerprint && declaredCompatibility !== undefined
          ? {
              ...declaredCompatibility,
              operationKinds: declaredCompatibility.operationKinds.filter(
                (kind) => kind !== "CompactionNative",
              ),
            }
          : declaredCompatibility;
      return Effect.succeed({
        ...withoutCatalogBindingFingerprint(chosen.capability),
        providerRef: chosen.adapterId,
        ...(completeBindingFingerprint ? { bindingFingerprint } : {}),
        ...(portableRequestCompatibility === undefined
          ? {}
          : { portableRequestCompatibility }),
      });
    },
  });

export { DEFAULT_MODEL_CATALOG } from "./model-catalog.data.js";
