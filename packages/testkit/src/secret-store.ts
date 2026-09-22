import { SecretMaterial, SecretStorePort } from "@arbor/ports";
import { Effect, Layer } from "effect";

/** Deterministic `SecretStorePort` double: resolves any reference to a fixed
 * material. Used only to satisfy the ProviderRuntime boundary in tests that do
 * not exercise secret resolution. */
export const FixedSecretStoreLive = (
  material = "test-secret-material",
): Layer.Layer<SecretStorePort> =>
  Layer.succeed(SecretStorePort, {
    resolve: () => Effect.succeed(SecretMaterial.of(material)),
  });
