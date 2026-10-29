import { join } from "node:path";
import { SandboxAuthorityProvisioningStore } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { loadSandboxAuthorityBundleSnapshotV2 } from "../dist/sandbox-authority-bundle.js";
import { makeSandboxAuthorityProvisioningFileStore } from "../dist/sandbox-authority-provisioning-file-store.js";
import { provisionSandboxAuthorityV1ToV2 } from "../dist/sandbox-authority-v1-v2-provisioning.js";

const [root, requestedStage, nonce] = process.argv.slice(2);
if (root === undefined || requestedStage === undefined || nonce === undefined)
  throw new Error("offline provisioning crash fixture arguments required");
const sourceIdentity = "host:offline-provisioning-test";
const sourcePath = join(root, "authority.json");
const highWaterPath = join(root, "high-water.json");
const evidenceDir = join(root, "forensic");

const store = await Effect.runPromise(
  makeSandboxAuthorityProvisioningFileStore({
    protectedRoot: root,
    sourceFile: sourcePath,
    highWaterFile: highWaterPath,
    forensicDirectory: evidenceDir,
    sourceIdentity,
  }),
);

if (requestedStage === "probe") {
  const loaded = await Effect.runPromise(
    loadSandboxAuthorityBundleSnapshotV2(store, "2026-10-19T00:00:00.000Z", [
      "PATH",
    ]),
  );
  process.stdout.write(
    `ARBOR_SANDBOX_AUTHORITY_RESTART_PROBE_V1:${nonce}:${JSON.stringify(loaded)}\n`,
  );
  process.exit(0);
}

const operatorConfig = {
  version: 1,
  revision: 1,
  environmentAllowlist: ["PATH"],
  limitsByProfile: [
    {
      profile: "ReadOnly",
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
      profile: "WorkspaceWrite",
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
      profile: "FullAccess",
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
  trustedLocalRuntimeVersion: "builtin-v1",
} as const;

const crashAt = (expected: string) => () =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        process.stdout.write(
          `ARBOR_SANDBOX_AUTHORITY_PROVISION_KILL_V1:${nonce}:${expected}:${process.pid}\n`,
          () => {
            try {
              if (!process.kill(process.pid, "SIGKILL"))
                throw new Error("process.kill returned false");
            } catch (error) {
              process.stderr.write(
                `ARBOR_SANDBOX_AUTHORITY_PROVISION_KILL_FAILED_V1:${nonce}:${expected}:${String(error)}\n`,
                () => process.exit(86),
              );
            }
            resolve();
          },
        );
      }),
  );

const stage =
  requestedStage === "before-high-water"
    ? "AfterV2SourceDurableBeforeHighWater"
    : "AfterV2HighWaterDurable";

Effect.runPromise(
  Effect.provide(
    provisionSandboxAuthorityV1ToV2({
      operatorConfig,
      qualificationProbe: {
        atStage: (current) =>
          current === stage ? crashAt(requestedStage)() : Effect.void,
      },
    }),
    Layer.succeed(SandboxAuthorityProvisioningStore, store),
  ),
).then(
  () => (process.exitCode = 0),
  (cause) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 2;
  },
);
