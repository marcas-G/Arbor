import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const sourceOf = (path: string): string =>
  readFileSync(join(repoRoot, path), "utf8");

describe("Failure presentation boundary", () => {
  it("never exposes native causes through Problem.safeDetails", () => {
    const projection = sourceOf(
      "packages/projection-runtime/src/query-runtime.ts",
    );
    const transport = sourceOf(
      "apps/single-workspace/src/transport/composition.ts",
    );
    const errors = sourceOf("apps/single-workspace/src/transport/errors.ts");
    expect(projection).not.toContain("safeDetails: { cause:");
    expect(transport).not.toContain("String(converged.error)");
    expect(transport).not.toContain("cause: executed.error");
    expect(errors).toContain("sanitizeSafeDetails");
    expect(errors).toContain("SENSITIVE_DETAIL_KEY");
  });

  it("allows terminal negative and uncertain ToolResults as verifier evidence", () => {
    const actions = sourceOf("apps/single-workspace/src/control-actions.ts");
    expect(actions).toContain("toolResultMatchesSettlement");
    expect(actions).toContain('case "Failed"');
    expect(actions).toContain('case "Interrupted"');
    expect(actions).toContain('case "OutcomeUnknown"');
    expect(actions).toContain("storedInvocation.value.settlement");
    expect(actions).not.toContain(
      "ToolObservation source must be a successful result",
    );
  });

  it("keeps Attention summaries derived from safe canonical facts", () => {
    const attention = sourceOf("packages/projection-runtime/src/attention.ts");
    expect(attention).not.toContain(".cause");
    expect(attention).not.toContain("safeDiagnostic");
    expect(attention).toContain("dedupKey");
  });
});
