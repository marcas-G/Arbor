import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const readSource = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("AH19 deployment-binding identity wiring", () => {
  it("passes only the Composition-Root fingerprint into model capability resolution", () => {
    const composition = readSource("apps/single-workspace/src/composition.ts");
    expect(composition).toMatch(
      /const deploymentFingerprint\s*=\s*deploymentBinding\s*===\s*undefined\s*\?\s*undefined\s*:\s*resolvedModelBindingFingerprint\(deploymentBinding\)/,
    );
    const capabilityCall = composition.match(
      /const capability = ModelCapabilityPortLive\(([\s\S]*?)\);/,
    )?.[1];
    expect(capabilityCall).toBeDefined();
    expect(capabilityCall).toContain("deploymentFingerprint");
    expect(capabilityCall).not.toMatch(/secretRef|SecretMaterial/);
  });

  it("threads capability identity into AgentStepContext and the durable Manifest without secret fields", () => {
    const modelDecision = readSource(
      "packages/agent-runtime/src/model-decision.ts",
    );
    const compiler = readSource("packages/model-context/src/compiler.ts");
    expect(modelDecision).toContain("bindingFingerprint:");
    expect(modelDecision).toContain("capability.bindingFingerprint");
    expect(modelDecision).toContain('"CompactionNative"');
    expect(compiler).toMatch(
      /resolvedModelBindingFingerprint:\s*input\.stepContext\?\.bindingFingerprint/,
    );
    expect(compiler).not.toMatch(/secretRef|SecretMaterial/);
  });

  it("keeps SecretRef and SecretMaterial at the Provider execution boundary", () => {
    const modelCatalog = readSource(
      "packages/model-context/src/model-catalog.ts",
    );
    expect(modelCatalog).not.toMatch(/SecretRef|SecretMaterial|secretRef/);
  });
});
