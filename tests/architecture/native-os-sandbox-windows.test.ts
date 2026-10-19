import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("Windows native sandbox boundary", () => {
  it("registers the probe-only provider at the composition boundary", () => {
    const appPackage = JSON.parse(
      source("apps/single-workspace/package.json"),
    ) as { dependencies: Record<string, string> };
    const composition = source("apps/single-workspace/src/composition.ts");

    expect(appPackage.dependencies["@arbor/sandbox-windows"]).toBe(
      "workspace:*",
    );
    expect(composition).toContain('from "@arbor/sandbox-windows"');
    expect(composition).toContain("makeWindowsSandboxProcessPort()");
    expect(composition).toContain("nativeSandboxProcessPort");
  });

  it("contains no arbitrary process or network spawn path", () => {
    const adapter = source("adapters/sandbox-windows/src/index.ts");
    const artifact = source("adapters/sandbox-windows/src/native-artifact.ts");
    expect(adapter).not.toMatch(/node:child_process|node:net/u);
    expect(adapter).not.toMatch(/\bspawn\s*\(|\bexecFile\s*\(/u);
    expect(adapter).not.toMatch(/CreateProcess(?:AsUser)?W/u);
    expect(artifact).not.toMatch(/node:child_process|node:net/u);
    expect(artifact).not.toMatch(/\bspawn\s*\(|\bexecFile\s*\(/u);
  });
});
