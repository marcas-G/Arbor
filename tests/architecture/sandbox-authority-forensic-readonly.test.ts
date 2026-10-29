import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("V1 sandbox authority forensic reader", () => {
  it("narrows authority input to a read-only port", () => {
    const implementation = source(
      "apps/single-workspace/src/sandbox-authority-bundle.ts",
    );
    expect(implementation).toMatch(
      /export type SandboxAuthorityForensicReadPort\s*=\s*Pick<\s*TrustedHostConfigurationSourceService,\s*"readVerifiedSandboxAuthorityBundle"\s*\|\s*"readSandboxAuthorityHighWater"\s*>/u,
    );
    const start = implementation.indexOf(
      "export const loadSandboxAuthorityBundleSnapshotV1Forensic",
    );
    const end = implementation.indexOf(
      "export const SandboxAuthoritySnapshotLive",
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const forensicPath = implementation.slice(start, end);
    expect(forensicPath).not.toMatch(
      /commitSandboxAuthorityHighWater|appendSandboxAuthorityAudit/u,
    );
  });

  it("does not give the forensic port any source mutation method", () => {
    const ports = source("packages/ports/src/trusted-host-config.ts");
    expect(ports).toContain("commitSandboxAuthorityHighWater");
    expect(ports).toContain("appendSandboxAuthorityAudit");
    const application = source(
      "apps/single-workspace/src/sandbox-authority-bundle.ts",
    );
    const forensicType = application.slice(
      application.indexOf("export type SandboxAuthorityForensicReadPort"),
      application.indexOf(
        "/** V1 decoder retained solely",
        application.indexOf("export type SandboxAuthorityForensicReadPort"),
      ),
    );
    expect(forensicType).not.toContain("commitSandboxAuthorityHighWater");
    expect(forensicType).not.toContain("appendSandboxAuthorityAudit");
  });
});
