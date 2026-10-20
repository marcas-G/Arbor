import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  Principal,
  parse,
} from "@arbor/domain";
import { describe, expect, it } from "vitest";
import {
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
  setP39PrivateWindowsAcl,
} from "../../../tests/support/p39-windows-deployment-test.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const seed = (root: string) => {
  if (process.platform !== "win32") chmodSync(root, 0o700);
  const forensic = join(root, "forensic");
  mkdirSync(forensic, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(forensic, 0o700);
  setP39PrivateWindowsAcl(forensic, "directory");
  const issuerConfig = {
    version: 1 as const,
    revision: 1,
    issuers: [parse(Principal)("user:operator")],
  };
  const operatorConfig = {
    version: 1 as const,
    revision: 1,
    environmentAllowlist: [] as string[],
    limitsByProfile: (
      ["ReadOnly", "WorkspaceWrite", "FullAccess"] as const
    ).map((profile) => ({
      profile,
      limits: {
        wallTimeMs: 1,
        stdoutBytes: 1,
        stderrBytes: 1,
        processCount: 1,
        memoryBytes: 1,
        cpuTimeMs: 1,
      },
    })),
    trustedLocalRuntimeVersion: "builtin-v1" as const,
  };
  const registry = { version: 1 as const, revision: 1, entries: [] };
  const bundle = {
    version: 2 as const,
    sourceIdentity: "host:test",
    bundleRevision: 2,
    issuerConfigRevision: 1,
    issuerConfigDigest: hash(
      '{"version":1,"revision":1,"issuers":["user:operator"]}',
    ),
    issuerConfig,
    operatorConfigRevision: 1,
    operatorConfigDigest: hash(
      encodeSandboxOperatorPolicyConfigV1(operatorConfig),
    ),
    operatorConfig,
    providerRegistryRevision: 1,
    providerRegistryDigest: hash('{"version":1,"revision":1,"entries":[]}'),
    providerRegistry: registry,
  };
  const source = encodeSandboxAuthorityBundleV2(bundle);
  const highWater = encodeSandboxAuthorityHighWaterV2({
    version: 2,
    sourceIdentity: bundle.sourceIdentity,
    bundleRevision: 2,
    bundleDigest: hash(source),
    issuerConfigRevision: 1,
    issuerConfigDigest: bundle.issuerConfigDigest,
    operatorConfigRevision: 1,
    operatorConfigDigest: bundle.operatorConfigDigest,
    providerRegistryRevision: 1,
    providerRegistryDigest: bundle.providerRegistryDigest,
  });
  const audit = '{"version":2,"outcome":"Loaded"}\n';
  for (const [path, bytes] of [
    [join(root, "authority.json"), source],
    [join(root, "high-water.json"), highWater],
    [join(forensic, "authority-audit.jsonl"), audit],
  ] as const) {
    writeFileSync(path, bytes, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(path, 0o600);
    setP39PrivateWindowsAcl(path, "file");
  }
  return { source, highWater, audit };
};

const childPath = fileURLToPath(
  new URL(
    "./sandbox-authority-v2-v3-provisioning.crash-child.ts",
    import.meta.url,
  ),
);
const runChild = (root: string, stage: string, nonce: string) =>
  spawnSync(
    process.execPath,
    ["--experimental-strip-types", childPath, root, stage, nonce],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
  );

describe("Windows D2 V3 protected file source process-crash cutover", () => {
  it.each(["before-source", "before-high-water", "after-high-water"] as const)(
    "%s survives exact process kill/restart without V2 fallback",
    (stage) => {
      const root = makeP39PrivateTestDirectory(
        tmpdir(),
        `arbor-d2-v3-${stage}-`,
      );
      try {
        const old = seed(root);
        const nonce = randomUUID();
        const killed = runChild(root, stage, nonce);
        const marker = new RegExp(
          `^ARBOR_D2_V3_KILL:${nonce}:${stage}:([0-9]+)$`,
          "gmu",
        );
        const matches = [...String(killed.stdout ?? "").matchAll(marker)];
        expect(matches, JSON.stringify(killed)).toHaveLength(1);
        expect(matches[0]?.[1]).toBe(String(killed.pid));
        expect(killed.error).toBeUndefined();
        if (process.platform === "win32") {
          expect(killed.status).toBe(1);
          expect(killed.signal).toBeNull();
        } else expect(killed.signal).toBe("SIGKILL");
        const restarted = runChild(root, "probe", nonce);
        expect(restarted.status, JSON.stringify(restarted)).toBe(0);
        const match = String(restarted.stdout ?? "").match(
          new RegExp(`^ARBOR_D2_V3_RESTART:${nonce}:(.+)$`, "mu"),
        );
        expect(match).not.toBeNull();
        const observation = JSON.parse(match?.[1] ?? "null");
        const source = readFileSync(join(root, "authority.json"), "utf8");
        const highWater = readFileSync(join(root, "high-water.json"), "utf8");
        const evidence = readdirSync(join(root, "forensic")).filter((name) =>
          name.endsWith(".raw"),
        );
        if (stage === "before-source") {
          expect(source).toBe(old.source);
          expect(highWater).toBe(old.highWater);
          expect(evidence).toEqual([]);
          expect(observation).toMatchObject({ _tag: "Available", version: 2 });
        } else {
          expect(JSON.parse(source).version).toBe(3);
          expect(evidence).toHaveLength(3);
          expect(
            readFileSync(
              join(root, "forensic", `v2-bundle-${hash(old.source)}.raw`),
              "utf8",
            ),
          ).toBe(old.source);
          expect(
            readFileSync(
              join(
                root,
                "forensic",
                `v2-high-water-${hash(old.highWater)}.raw`,
              ),
              "utf8",
            ),
          ).toBe(old.highWater);
          expect(
            readFileSync(
              join(root, "forensic", `v2-audit-${hash(old.audit)}.raw`),
              "utf8",
            ),
          ).toBe(old.audit);
          if (stage === "before-high-water") {
            expect(highWater).toBe(old.highWater);
            expect(observation).toMatchObject({ _tag: "Unavailable" });
          } else {
            expect(JSON.parse(highWater).version).toBe(3);
            expect(observation).toMatchObject({
              _tag: "Available",
              version: 3,
            });
          }
        }
      } finally {
        removeP39PrivateTestDirectory(root);
      }
    },
    120_000,
  );
});
