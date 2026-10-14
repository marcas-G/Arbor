import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const sourceOf = (relative: string) =>
  readFileSync(join(repoRoot, relative), "utf8");

describe("P39/P40 production tool-runtime composition", () => {
  it("injects recovery binding and canonical observation stores", () => {
    const composition = sourceOf("apps/single-workspace/src/composition.ts");
    const recoveryBindingStore = sourceOf(
      "adapters/persistence-sqlite/src/recovery-binding-store.ts",
    );

    expect(composition).toMatch(
      /readonly p39RecoveryBindingQualificationProbe\?: P39RecoveryBindingQualificationProbe/u,
    );
    expect(composition).toMatch(
      /Layer\.provide\(\s*makeP39RecoveryEvidenceStoreLive\(\s*config\.p39RecoveryBindingQualificationProbe,\s*\),\s*infra,\s*\)/u,
    );
    expect(recoveryBindingStore).toMatch(
      /export const makeP39RecoveryEvidenceStoreLive = \(\s*qualificationProbe\?: P39RecoveryBindingQualificationProbe,/u,
    );
    expect(recoveryBindingStore).toContain(
      "if (qualificationProbe !== undefined)",
    );
    expect(recoveryBindingStore).toContain(
      "export const P39RecoveryEvidenceStoreLive = makeP39RecoveryEvidenceStoreLive();",
    );
    expect(recoveryBindingStore).toContain('} from "@arbor/ports"');
    expect(recoveryBindingStore).not.toMatch(
      /from ["']@arbor\/(?:application|single-workspace)/u,
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
