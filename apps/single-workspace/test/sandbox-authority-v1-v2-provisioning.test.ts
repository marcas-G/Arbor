import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeCanonicalSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  Principal,
  parse,
} from "@arbor/domain";
import {
  validateP39ProtectedDirectory,
  validateP39ProtectedFile,
} from "@arbor/persistence-sqlite";
import {
  SANDBOX_ENV_ALLOWLIST,
  SandboxAuthorityProvisioningStore,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
  setP39PrivateWindowsAcl,
} from "../../../tests/support/p39-windows-deployment-test.js";
import {
  loadSandboxAuthorityBundleSnapshotV1Forensic,
  loadSandboxAuthorityBundleSnapshotV2,
} from "../src/sandbox-authority-bundle.js";
import { runSandboxAuthorityProvisioningCommand } from "../src/transport/sandbox-authority-provisioning-cli.js";
import { makeSandboxAuthorityProvisioningFileStore } from "../src/sandbox-authority-provisioning-file-store.js";
import { provisionSandboxAuthorityV1ToV2 } from "../src/sandbox-authority-v1-v2-provisioning.js";

const sourceIdentity = "host:offline-provisioning-test";
const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const issuerConfigJson = `{"version":1,"revision":1,"issuers":[${JSON.stringify(String(parse(Principal)("user:operator")))}]}`;
const providerRegistryJson = `{"version":1,"revision":1,"entries":[]}`;
const issuerDigest = sha(issuerConfigJson);
const registryDigest = sha(providerRegistryJson);
const v1BundleJson = `{"version":1,"sourceIdentity":${JSON.stringify(sourceIdentity)},"bundleRevision":1,"issuerConfigRevision":1,"issuerConfigDigest":${JSON.stringify(issuerDigest)},"issuerConfig":${issuerConfigJson},"providerRegistryRevision":1,"providerRegistryDigest":${JSON.stringify(registryDigest)},"providerRegistry":${providerRegistryJson}}`;
const v1BundleDigest = sha(v1BundleJson);
const v1HighWaterJson = `{"version":1,"sourceIdentity":${JSON.stringify(sourceIdentity)},"bundleRevision":1,"bundleDigest":${JSON.stringify(v1BundleDigest)},"issuerConfigRevision":1,"issuerConfigDigest":${JSON.stringify(issuerDigest)},"providerRegistryRevision":1,"providerRegistryDigest":${JSON.stringify(registryDigest)}}`;
const operatorConfig = {
  version: 1 as const,
  revision: 1,
  environmentAllowlist: ["PATH"],
  limitsByProfile: [
    {
      profile: "ReadOnly" as const,
      limits: {
        wallTimeMs: 60000,
        stdoutBytes: 8192,
        stderrBytes: 8192,
        processCount: 8,
        memoryBytes: 134217728,
        cpuTimeMs: 30000,
      },
    },
    {
      profile: "WorkspaceWrite" as const,
      limits: {
        wallTimeMs: 60000,
        stdoutBytes: 8192,
        stderrBytes: 8192,
        processCount: 8,
        memoryBytes: 134217728,
        cpuTimeMs: 30000,
      },
    },
    {
      profile: "FullAccess" as const,
      limits: {
        wallTimeMs: 60000,
        stdoutBytes: 8192,
        stderrBytes: 8192,
        processCount: 8,
        memoryBytes: 134217728,
        cpuTimeMs: 30000,
      },
    },
  ],
  trustedLocalRuntimeVersion: "builtin-v1" as const,
};

const provisionArgs = (
  root: string,
  stage: "before-high-water" | "after-high-water",
  nonce: string,
) => [
  "--experimental-strip-types",
  fileURLToPath(
    new URL(
      "./sandbox-authority-v1-v2-provisioning.crash-child.ts",
      import.meta.url,
    ),
  ),
  root,
  stage,
  nonce,
];

const restartProbe = (root: string, nonce: string) =>
  spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "./sandbox-authority-v1-v2-provisioning.crash-child.ts",
          import.meta.url,
        ),
      ),
      root,
      "probe",
      nonce,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
  );

const assertExactKill = (
  result: ReturnType<typeof spawnSync>,
  nonce: string,
  stage: string,
) => {
  const marker = new RegExp(
    `^ARBOR_SANDBOX_AUTHORITY_PROVISION_KILL_V1:${nonce}:${stage}:([0-9]+)$`,
    "gmu",
  );
  const matches = [...String(result.stdout ?? "").matchAll(marker)];
  expect(matches, JSON.stringify(result)).toHaveLength(1);
  expect(matches[0]?.[1]).toBe(String(result.pid));
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  if (process.platform === "win32") {
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  } else {
    expect(result.signal).toBe("SIGKILL");
    expect([null, 137]).toContain(result.status);
  }
};

const pathsFor = (root: string) => ({
  protectedRoot: root,
  sourceFile: join(root, "authority.json"),
  highWaterFile: join(root, "high-water.json"),
  forensicDirectory: join(root, "forensic"),
  sourceIdentity,
});

const seed = (root: string) => {
  if (process.platform !== "win32") chmodSync(root, 0o700);
  const forensic = join(root, "forensic");
  mkdirSync(forensic, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(forensic, 0o700);
  setP39PrivateWindowsAcl(forensic, "directory");
  writeFileSync(join(root, "authority.json"), v1BundleJson, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(join(root, "high-water.json"), v1HighWaterJson, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(
    join(root, "operator-config.json"),
    encodeSandboxOperatorPolicyConfigV1(operatorConfig),
    { encoding: "utf8", mode: 0o600 },
  );
  if (process.platform !== "win32") {
    chmodSync(join(root, "authority.json"), 0o600);
    chmodSync(join(root, "high-water.json"), 0o600);
    chmodSync(join(root, "operator-config.json"), 0o600);
  }
  for (const filename of [
    "authority.json",
    "high-water.json",
    "operator-config.json",
  ])
    setP39PrivateWindowsAcl(join(root, filename), "file");
};

describe("P5 operator-only V1→V2 sandbox authority provisioning", () => {
  it("runs the explicit file-based offline CLI over protected disposable inputs", async () => {
    const root = makeP39PrivateTestDirectory(
      tmpdir(),
      "arbor-sandbox-provision-cli-",
    );
    try {
      seed(root);
      const result = await Effect.runPromise(
        runSandboxAuthorityProvisioningCommand([
          "--offline-v1-to-v2",
          "--protected-root",
          root,
          "--source-file",
          join(root, "authority.json"),
          "--high-water-file",
          join(root, "high-water.json"),
          "--forensic-directory",
          join(root, "forensic"),
          "--operator-config-file",
          join(root, "operator-config.json"),
          "--source-identity",
          sourceIdentity,
        ]),
      );
      expect(result.v2Bundle.bundleRevision).toBe(2);
      expect(
        JSON.parse(readFileSync(join(root, "authority.json"), "utf8")),
      ).toMatchObject({ version: 2, bundleRevision: 2, sourceIdentity });
      expect(
        decodeCanonicalSandboxAuthorityHighWaterV2(
          readFileSync(join(root, "high-water.json"), "utf8"),
        ),
      ).toMatchObject({ version: 2, bundleRevision: 2, sourceIdentity });
    } finally {
      removeP39PrivateTestDirectory(root);
    }
  }, 60_000);

  it("preserves V1 raw evidence and refuses invalid operator config before writes", async () => {
    const root = makeP39PrivateTestDirectory(
      tmpdir(),
      "arbor-sandbox-provision-refusal-",
    );
    try {
      seed(root);
      expect(validateP39ProtectedDirectory(root)).toBe(true);
      expect(validateP39ProtectedFile(join(root, "authority.json"))).toBe(true);
      expect(validateP39ProtectedFile(join(root, "high-water.json"))).toBe(
        true,
      );
      const store = await Effect.runPromise(
        makeSandboxAuthorityProvisioningFileStore(pathsFor(root)),
      );
      const invalid = await Effect.runPromise(
        Effect.result(
          Effect.provideService(
            provisionSandboxAuthorityV1ToV2({ operatorConfig: {} }),
            SandboxAuthorityProvisioningStore,
            store,
          ),
        ),
      );
      expect(invalid._tag).toBe("Failure");
      expect(readFileSync(join(root, "authority.json"), "utf8")).toBe(
        v1BundleJson,
      );
      expect(readFileSync(join(root, "high-water.json"), "utf8")).toBe(
        v1HighWaterJson,
      );
      expect(existsSync(join(root, "forensic"))).toBe(true);
      expect(
        readdirSync(join(root, "forensic")).filter((name) =>
          name.endsWith(".raw"),
        ),
      ).toEqual([]);
    } finally {
      removeP39PrivateTestDirectory(root);
    }
  }, 60_000);

  it("fails closed when evidence preservation or V2 source readback cannot be proven", async () => {
    const root = makeP39PrivateTestDirectory(
      tmpdir(),
      "arbor-sandbox-provision-failures-",
    );
    try {
      seed(root);
      const store = await Effect.runPromise(
        makeSandboxAuthorityProvisioningFileStore(pathsFor(root)),
      );
      const run = (override: typeof store) =>
        Effect.runPromise(
          Effect.result(
            Effect.provideService(
              provisionSandboxAuthorityV1ToV2({ operatorConfig }),
              SandboxAuthorityProvisioningStore,
              override,
            ),
          ),
        );
      const preservationFailure = await run({
        ...store,
        preserveForensicEvidence: () => Effect.succeed(false),
      });
      expect(preservationFailure._tag).toBe("Failure");
      expect(readFileSync(join(root, "authority.json"), "utf8")).toBe(
        v1BundleJson,
      );
      expect(readFileSync(join(root, "high-water.json"), "utf8")).toBe(
        v1HighWaterJson,
      );

      const sourceVerificationFailure = await run({
        ...store,
        writeSandboxAuthorityBundleAtomically: () => Effect.succeed(true),
      });
      expect(sourceVerificationFailure._tag).toBe("Failure");
      expect(readFileSync(join(root, "authority.json"), "utf8")).toBe(
        v1BundleJson,
      );
      expect(readFileSync(join(root, "high-water.json"), "utf8")).toBe(
        v1HighWaterJson,
      );
    } finally {
      removeP39PrivateTestDirectory(root);
    }
  }, 60_000);

  it.each([
    ["before-high-water", "before-high-water"],
    ["after-high-water", "after-high-water"],
  ] as const)(
    "process kill at %s preserves only the state allowed by the atomic boundary",
    async (stage, markerStage) => {
      const root = makeP39PrivateTestDirectory(
        tmpdir(),
        `arbor-sandbox-provision-${stage}-`,
      );
      try {
        seed(root);
        const nonce = randomUUID();
        const child = spawnSync(
          process.execPath,
          provisionArgs(root, stage, nonce),
          {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 120_000,
          },
        );
        assertExactKill(child, nonce, markerStage);
        const restarted = restartProbe(root, nonce);
        expect(restarted.error).toBeUndefined();
        expect(restarted.status).toBe(0);
        expect(restarted.signal).toBeNull();
        expect(restarted.stderr).toBe("");
        const restartMarker = new RegExp(
          `^ARBOR_SANDBOX_AUTHORITY_RESTART_PROBE_V1:${nonce}:(.+)$`,
          "mu",
        );
        const restartMatch = String(restarted.stdout ?? "").match(
          restartMarker,
        );
        expect(restartMatch, JSON.stringify(restarted)).not.toBeNull();
        const restartedSnapshot = JSON.parse(restartMatch?.[1] ?? "null") as {
          readonly _tag: string;
        };
        const sourceBytes = readFileSync(join(root, "authority.json"), "utf8");
        const activeHighWater = readFileSync(
          join(root, "high-water.json"),
          "utf8",
        );
        const bundleEvidenceId = `v1-bundle-${sha(v1BundleJson)}`;
        const highWaterEvidenceId = `v1-high-water-${sha(v1HighWaterJson)}`;
        expect(
          readFileSync(
            join(root, "forensic", `${bundleEvidenceId}.raw`),
            "utf8",
          ),
        ).toBe(v1BundleJson);
        expect(
          readFileSync(
            join(root, "forensic", `${highWaterEvidenceId}.raw`),
            "utf8",
          ),
        ).toBe(v1HighWaterJson);

        const store = await Effect.runPromise(
          makeSandboxAuthorityProvisioningFileStore(pathsFor(root)),
        );
        const v2 = await Effect.runPromise(
          loadSandboxAuthorityBundleSnapshotV2(
            store,
            "2026-10-19T00:00:00.000Z",
            SANDBOX_ENV_ALLOWLIST,
          ),
        );
        if (stage === "before-high-water") {
          expect(activeHighWater).toBe(v1HighWaterJson);
          expect(JSON.parse(sourceBytes).version).toBe(2);
          expect(v2).toMatchObject({ _tag: "Unavailable" });
          expect(restartedSnapshot._tag).toBe("Unavailable");
          const forensic = await Effect.runPromise(
            loadSandboxAuthorityBundleSnapshotV1Forensic(store),
          );
          expect(forensic).toMatchObject({ _tag: "Unavailable" });
        } else {
          expect(JSON.parse(sourceBytes).bundleRevision).toBe(2);
          expect(activeHighWater).not.toBe(v1HighWaterJson);
          expect(
            decodeCanonicalSandboxAuthorityHighWaterV2(activeHighWater),
          ).toMatchObject({
            version: 2,
            sourceIdentity,
            bundleRevision: 2,
          });
          expect(v2).toMatchObject({
            _tag: "Available",
            snapshot: {
              bundle: { version: 2, sourceIdentity, bundleRevision: 2 },
            },
          });
          expect(restartedSnapshot._tag).toBe("Available");
        }
      } finally {
        removeP39PrivateTestDirectory(root);
      }
    },
    120_000,
  );
});
