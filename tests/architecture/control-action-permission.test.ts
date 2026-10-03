import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("CAPA control permission and approval architecture", () => {
  it("requires subject-bound, target-bound, time-bounded grants", () => {
    const domain = source("packages/domain/src/authority.ts");
    const resolver = source("packages/application/src/authority-resolver.ts");
    for (const marker of [
      "PermissionSubject",
      "WorkspaceAgent",
      "Execution",
      "validFrom",
      "expiresAt",
    ]) {
      expect(domain).toContain(marker);
    }
    expect(resolver).toContain("grant.subject === undefined");
    expect(resolver).toContain("subjectMatches");
    expect(resolver).toContain("grant.target");
  });

  it("interrupts before handler execution and resumes the same execution", () => {
    const actions = source("packages/agent-runtime/src/agent-loop-actions.ts");
    const runtime = source(
      "packages/execution-runtime/src/execution-runtime.ts",
    );
    const daemon = source("apps/single-workspace/src/production.ts");
    expect(
      actions.indexOf('authorization._tag === "ApprovalRequired"'),
    ).toBeLessThan(actions.indexOf("controlRegistry.handle"));
    expect(runtime).toContain('outcome._tag === "ApprovalRequired"');
    expect(runtime).toContain("leases.release");
    expect(daemon).toContain("controlApprovals.listResolved()");
    expect(daemon).toContain('{ _tag: "HumanIntervention" }');
  });

  it("persists exact approvals and exposes governed MAC-P2 placement", () => {
    const migrations = source("adapters/persistence-sqlite/src/migrations.ts");
    const profile = source("packages/model-context/src/turn-profile.ts");
    expect(migrations).toContain('name: "subject_bound_permission_grants"');
    expect(migrations).toContain('name: "control_action_approvals"');
    expect(profile).toContain('"core.control.assign-work"');
    expect(profile).toContain("workControls.has(tool.stableId)");
    expect(profile).toContain('"core.control.assign-work"');
    expect(profile).toContain('"core.control.propose-workspace"');
  });
});
