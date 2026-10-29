import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installSandboxPolicyV3SyntheticArtifactsAtPaths,
  type SandboxPolicyV3SyntheticArtifactPaths,
  type SandboxPolicyV3TestPair,
} from "./functional/support/sandbox-policy-v3-source.js";

const directories: string[] = [];
const makeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-v3-artifact-installer-"));
  directories.push(root);
  const artifactRoot = join(root, "artifacts");
  const testControlRoot = join(artifactRoot, "test-controls");
  const paths: SandboxPolicyV3SyntheticArtifactPaths = {
    source: join(artifactRoot, "source.cs"),
    binary: join(artifactRoot, "host.exe"),
    manifest: join(artifactRoot, "manifest.json"),
    signature: join(artifactRoot, "manifest.sig"),
    compiler: join(root, "compiler.exe"),
    control: join(testControlRoot, "control.artifact"),
    testControlRoot,
  };
  const pair = {
    sourceArtifactBytes: Buffer.from("source expected"),
    binaryArtifactBytes: Buffer.from("binary expected"),
    manifestBytes: Buffer.from("manifest expected"),
    signatureBytes: Buffer.from("signature expected"),
    compilerArtifactBytes: Buffer.from("compiler expected"),
    controlArtifactBytes: Buffer.from("control expected"),
  } as SandboxPolicyV3TestPair;
  writeFileSync(paths.compiler, pair.compilerArtifactBytes);
  return { root, artifactRoot, paths, pair };
};

const artifactPairs = (
  paths: SandboxPolicyV3SyntheticArtifactPaths,
  pair: SandboxPolicyV3TestPair,
) =>
  [
    [paths.source, pair.sourceArtifactBytes],
    [paths.binary, pair.binaryArtifactBytes],
    [paths.manifest, pair.manifestBytes],
    [paths.signature, pair.signatureBytes],
    [paths.control, pair.controlArtifactBytes],
  ] as const;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("V3 synthetic artifact installer", () => {
  it("installs a clean set and cleanup restores the empty prestate", () => {
    const { root, artifactRoot, paths, pair } = makeFixture();
    const cleanup = installSandboxPolicyV3SyntheticArtifactsAtPaths(
      pair,
      paths,
    );
    for (const [path, bytes] of artifactPairs(paths, pair))
      expect(readFileSync(path).equals(bytes)).toBe(true);
    cleanup();
    expect(existsSync(artifactRoot)).toBe(false);
    expect(readdirSync(root)).toEqual(["compiler.exe"]);
  });

  it("adopts exact partial artifacts and cleanup removes only the missing source", () => {
    const { artifactRoot, paths, pair } = makeFixture();
    mkdirSync(paths.testControlRoot, { recursive: true });
    for (const [path, bytes] of artifactPairs(paths, pair))
      if (path !== paths.source) writeFileSync(path, bytes);
    const before = new Map(
      artifactPairs(paths, pair)
        .filter(([path]) => path !== paths.source)
        .map(([path]) => [path, readFileSync(path)]),
    );

    const cleanup = installSandboxPolicyV3SyntheticArtifactsAtPaths(
      pair,
      paths,
    );
    expect(readFileSync(paths.source).equals(pair.sourceArtifactBytes)).toBe(
      true,
    );
    cleanup();

    expect(existsSync(paths.source)).toBe(false);
    for (const [path, bytes] of before)
      expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(existsSync(artifactRoot)).toBe(true);
  });

  it("refuses byte mismatch before creating any missing artifact", () => {
    const { paths, pair } = makeFixture();
    mkdirSync(paths.testControlRoot, { recursive: true });
    writeFileSync(paths.binary, "different");
    expect(() =>
      installSandboxPolicyV3SyntheticArtifactsAtPaths(pair, paths),
    ).toThrow(`${paths.binary}: ExistingTargetBytesMismatch`);
    expect(existsSync(paths.source)).toBe(false);
    expect(readFileSync(paths.binary, "utf8")).toBe("different");
  });

  it("refuses symlink targets without modifying their referent", () => {
    const { paths, pair, root } = makeFixture();
    const target = join(root, "outside.bin");
    writeFileSync(target, pair.binaryArtifactBytes);
    try {
      symlinkSync(target, paths.binary, "file");
    } catch {
      return;
    }
    expect(() =>
      installSandboxPolicyV3SyntheticArtifactsAtPaths(pair, paths),
    ).toThrow(`${paths.binary}: ExistingTargetNotRegularFile`);
    expect(lstatSync(paths.binary).isSymbolicLink()).toBe(true);
    expect(readFileSync(target).equals(pair.binaryArtifactBytes)).toBe(true);
    expect(existsSync(paths.source)).toBe(false);
  });
});
