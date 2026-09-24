import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// D-1 closure: static guards for the additive read-model carriers. These
// guards intentionally cover projection + API/fixture producers. Binding the
// already-deferred W-08 controls to these server values is D7 work, not part
// of this read-model-only authorization.

const repoRoot = join(import.meta.dirname, "..", "..");

const sourceOf = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

describe("D-1 product UI contract closure", () => {
  it("records the server-projected hierarchy and command revision carriers", () => {
    const apiViews = sourceOf("packages/api-contracts/src/views.ts");
    const tree = sourceOf("packages/projection-runtime/src/tree.ts");
    const currentWork = sourceOf(
      "packages/projection-runtime/src/views/current-work.ts",
    );
    const detail = sourceOf(
      "packages/projection-runtime/src/views/workspace-detail.ts",
    );
    const verification = sourceOf(
      "packages/projection-runtime/src/views/verification.ts",
    );

    expect(apiViews).toContain("parentWorkspaceId: WorkspaceId | null");
    expect(apiViews).toContain("readonly revision: WorkRevision");
    expect(apiViews).toContain("export type VerificationIdentity");
    expect(apiViews).toContain("readonly targetWorkRevision: WorkRevision");
    expect(tree).toContain("validateResponsibilityHierarchy");
    expect(tree).toContain("parentWorkspaceId: workspace.parentWorkspaceId");
    expect(currentWork).toContain("revision: work.value.revision");
    expect(detail).toContain("revision: work.value.revision");
    expect(verification).toContain("verificationIdentityView(selected)");
  });

  it("does not introduce a revision=0 fallback in a D-1 read-model producer or Web fixture", () => {
    const d1Producers = [
      "packages/api-contracts/src/views.ts",
      "packages/projection-runtime/src/tree.ts",
      "packages/projection-runtime/src/query-runtime.ts",
      "packages/projection-runtime/src/views/current-work.ts",
      "packages/projection-runtime/src/views/workspace-detail.ts",
      "packages/projection-runtime/src/views/verification.ts",
      "apps/web/src/views/fixtures.ts",
      "apps/web/src/pages/work/fixtures.ts",
      "apps/web/src/pages/workspace/fixtures.ts",
    ].map(sourceOf);
    const fallback =
      /(?:expectedWorkRevision|targetWorkRevision|revision)\s*(?::|=)\s*0\b/;

    for (const producer of d1Producers) {
      expect(producer).not.toMatch(fallback);
    }
  });

  it("keeps the tree wire adapter preorder-only and omits null current-work", () => {
    const runtime = sourceOf(
      "packages/projection-runtime/src/query-runtime.ts",
    );

    expect(runtime).toContain("...children.flatMap");
    expect(runtime).toContain("currentWork === null ? wireNode");
    expect(runtime).not.toContain("children: undefined");
  });

  it("requires the planned Workbench to select its root from the server parent carrier", () => {
    const implementationSpec = sourceOf(
      "planning/proposals/web-product-ui/01-implementation-spec.md",
    );
    const closure = sourceOf(
      "planning/proposals/web-product-ui/02-contract-closure.md",
    );

    expect(implementationSpec).toContain("parentWorkspaceId === null");
    expect(closure).toContain("parentWorkspaceId === null");
    expect(implementationSpec).not.toContain("nodes[0]");
    expect(closure).not.toContain("nodes[0]");
  });
});
