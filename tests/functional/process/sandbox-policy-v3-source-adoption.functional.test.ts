import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedWindowsNativeProductionArtifactPaths } from "../../../adapters/sandbox-windows/dist/index.js";
import {
  installSandboxPolicyV3SyntheticArtifactsAtPaths,
  type SandboxPolicyV3SyntheticArtifactPaths,
  sandboxPolicyV3TestPair,
} from "../support/sandbox-policy-v3-source.js";

const withArtifactPaths = (
  root: string,
  compiler: string,
): SandboxPolicyV3SyntheticArtifactPaths => ({
  source: join(root, "WindowsSandboxProcessHost.cs"),
  binary: join(root, "WindowsSandboxProcessHost.exe"),
  manifest: join(root, "qualification-manifest-v1.json"),
  signature: join(root, "qualification-manifest-v1.sig"),
  compiler,
  control: join(root, "test-controls", "control-token.artifact"),
  testControlRoot: join(root, "test-controls"),
});

describe("V6 V3 synthetic artifact setup", () => {
  it.skipIf(
    process.platform !== "win32" ||
      !existsSync(fixedWindowsNativeProductionArtifactPaths().binary),
  )(
    "adopts the exact installed source and binary bytes and cleans up only new artifacts",
    () => {
      const fixedPaths = fixedWindowsNativeProductionArtifactPaths();
      const pair = sandboxPolicyV3TestPair();
      expect(pair.sourceArtifactBytes).toEqual(readFileSync(fixedPaths.source));
      expect(pair.binaryArtifactBytes).toEqual(readFileSync(fixedPaths.binary));

      const root = mkdtempSync(join(tmpdir(), "arbor-sandbox-v3-adopt-"));
      const paths = withArtifactPaths(root, fixedPaths.compiler);
      writeFileSync(paths.source, pair.sourceArtifactBytes);
      writeFileSync(paths.binary, pair.binaryArtifactBytes);
      try {
        const cleanup = installSandboxPolicyV3SyntheticArtifactsAtPaths(
          pair,
          paths,
        );
        expect(readFileSync(paths.source)).toEqual(pair.sourceArtifactBytes);
        expect(readFileSync(paths.binary)).toEqual(pair.binaryArtifactBytes);
        expect(existsSync(paths.manifest)).toBe(true);
        expect(existsSync(paths.signature)).toBe(true);
        expect(existsSync(paths.control)).toBe(true);

        cleanup();

        expect(existsSync(paths.source)).toBe(true);
        expect(existsSync(paths.binary)).toBe(true);
        expect(existsSync(paths.manifest)).toBe(false);
        expect(existsSync(paths.signature)).toBe(false);
        expect(existsSync(paths.control)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["source", "binary"] as const)(
    "refuses an existing %s whose bytes differ from the signed pair",
    (artifact) => {
      if (process.platform !== "win32") return;
      const fixedPaths = fixedWindowsNativeProductionArtifactPaths();
      const pair = sandboxPolicyV3TestPair();
      const root = mkdtempSync(join(tmpdir(), "arbor-sandbox-v3-mismatch-"));
      const paths = withArtifactPaths(root, fixedPaths.compiler);
      const target = paths[artifact];
      const mismatchedBytes = Buffer.from("existing artifact bytes differ\n");
      writeFileSync(target, mismatchedBytes);
      try {
        expect(() =>
          installSandboxPolicyV3SyntheticArtifactsAtPaths(pair, paths),
        ).toThrow("ExistingTargetBytesMismatch");
        expect(readFileSync(target)).toEqual(mismatchedBytes);
        expect(existsSync(paths.manifest)).toBe(false);
        expect(existsSync(paths.signature)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
