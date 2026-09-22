import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentContextSourcePort,
  KnowledgeQueryPort,
  ModelCapabilityPort,
  ProviderPort,
  SecretMaterial,
  SecretStorePort,
  SkillRegistry,
  secretRef,
  ToolCatalogPort,
} from "../packages/ports/src/index.js";

describe("P3 ports", () => {
  it("exports the P3 Effect services with stable keys", () => {
    expect(ProviderPort.key).toBe("arbor/ProviderPort");
    expect(ModelCapabilityPort.key).toBe("arbor/ModelCapabilityPort");
    expect(SkillRegistry.key).toBe("arbor/SkillRegistry");
    expect(AgentContextSourcePort.key).toBe("arbor/AgentContextSourcePort");
    expect(KnowledgeQueryPort.key).toBe("arbor/KnowledgeQueryPort");
    expect(ToolCatalogPort.key).toBe("arbor/ToolCatalogPort");
    expect(SecretStorePort.key).toBe("arbor/SecretStorePort");
  });

  it("SecretStorePort.resolve(SecretRef) carries the typed failure channel (P12 `03` §2)", async () => {
    const store = Layer.succeed(SecretStorePort, {
      resolve: (ref) =>
        Effect.fail({ _tag: "SecretNotFound" as const, secretRef: ref }),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const port = yield* SecretStorePort;
          const error = yield* Effect.flip(port.resolve(secretRef("missing")));
          return {
            tag: error._tag,
            redacted: JSON.stringify(SecretMaterial.of("raw-credential")),
          };
        }),
        store,
      ),
    );
    expect(result.tag).toBe("SecretNotFound");
    expect(result.redacted).toBe('"[REDACTED]"');
  });
});
