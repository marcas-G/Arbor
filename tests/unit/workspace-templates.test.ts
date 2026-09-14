import { describe, expect, it } from "vitest";
import {
  renderOverviewMd,
  renderSummaryMd,
  renderVerificationMd,
  renderWorkspaceMd,
  renderWorkspaceYaml,
} from "../../src/application/workspace-templates.js";

describe("root workspace skeleton templates (§18.1)", () => {
  it("workspace.yaml has schemaVersion 1 and empty verification commands", () => {
    const y = renderWorkspaceYaml({ projectId: "p-1", workspaceId: "w-1" });
    expect(y).toContain("schemaVersion: 1");
    expect(y).toContain('projectId: "p-1"');
    expect(y).toContain('workspaceId: "w-1"');
    expect(y).toContain('writable:');
    expect(y).toContain('    - "."');
    expect(y).toContain("commands: []");
  });
  it("WORKSPACE.md intent is the literal TBD", () => {
    expect(renderWorkspaceMd()).toContain("TBD (user to fill)");
  });
  it("renders all four md files non-empty", () => {
    for (const s of [renderSummaryMd(), renderOverviewMd(), renderVerificationMd()]) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});
