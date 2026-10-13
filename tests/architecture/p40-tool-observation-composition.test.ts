import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const sourceOf = (relative: string) =>
  readFileSync(join(repoRoot, relative), "utf8");

describe("P39/P40 production tool-runtime composition", () => {
  it("injects recovery binding and canonical observation stores", () => {
    const composition = sourceOf("apps/single-workspace/src/composition.ts");

    expect(composition).toContain("P39RecoveryEvidenceStoreLive");
    expect(composition).toContain(
      "Layer.provide(P39RecoveryEvidenceStoreLive, infra)",
    );
    expect(composition).toContain("ToolObservationEvidenceStoreLive");
    expect(composition).toContain(
      "Layer.provide(ToolObservationEvidenceStoreLive, infra)",
    );
    expect(composition).toMatch(/Layer\.mergeAll\(\s+repos,/);
  });

  it("retains the optional low-level fallback and missing-evidence failures", () => {
    const runtime = sourceOf("packages/tool-runtime/src/runtime.ts");

    expect(runtime).toContain("Effect.serviceOption(P39RecoveryEvidenceStore)");
    expect(runtime).toContain(
      "const p39BindingEnabled = Option.isSome(p39Recovery)",
    );
    expect(runtime).toMatch(
      /Effect\.serviceOption\(\s*ToolObservationEvidenceStore,/,
    );
    expect(runtime).toContain('_tag: "P40ObservationEvidenceStoreUnavailable"');
    expect(runtime).toContain("store.settle(");
  });
});
