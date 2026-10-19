import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { SandboxAuthorityProvisioningStore } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { provisionSandboxAuthorityV1ToV2 } from "../dist/sandbox-authority-v1-v2-provisioning.js";

const [root, requestedStage, nonce] = process.argv.slice(2);
if (root === undefined || requestedStage === undefined || nonce === undefined)
  throw new Error("offline provisioning crash fixture arguments required");
const sourceIdentity = "host:offline-provisioning-test";
const sourcePath = join(root, "authority.json");
const highWaterPath = join(root, "high-water.json");
const evidenceDir = join(root, "forensic");
mkdirSync(evidenceDir, { recursive: true });

const atomicWrite = (path: string, exactBytes: string) => {
  const temporary = join(
    root,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, exactBytes, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
};

const store = SandboxAuthorityProvisioningStore.of({
  readVerifiedSandboxAuthorityBundle: () =>
    Effect.try({
      try: () =>
        existsSync(sourcePath)
          ? {
              sourceIdentity,
              canonicalJson: readFileSync(sourcePath, "utf8"),
            }
          : undefined,
      catch: () => "SourceUnreadable" as const,
    }),
  readSandboxAuthorityHighWater: () =>
    Effect.try({
      try: () =>
        existsSync(highWaterPath)
          ? readFileSync(highWaterPath, "utf8")
          : undefined,
      catch: () => "HighWaterUnreadable" as const,
    }),
  commitSandboxAuthorityHighWater: (canonicalJson) =>
    Effect.try({
      try: () => {
        atomicWrite(highWaterPath, canonicalJson);
        return true;
      },
      catch: () => "HighWaterCommitFailed" as const,
    }),
  appendSandboxAuthorityAudit: () => Effect.succeed(true),
  writeSandboxAuthorityBundleAtomically: (canonicalJson) =>
    Effect.try({
      try: () => {
        atomicWrite(sourcePath, canonicalJson);
        return true;
      },
      catch: () => "SourceUnreadable" as const,
    }),
  preserveForensicEvidence: ({ evidenceId, exactBytes }) =>
    Effect.try({
      try: () => {
        const path = join(evidenceDir, `${evidenceId}.raw`);
        try {
          const descriptor = openSync(path, "wx", 0o600);
          try {
            writeFileSync(descriptor, exactBytes, "utf8");
            fsyncSync(descriptor);
          } finally {
            closeSync(descriptor);
          }
          return true;
        } catch {
          return existsSync(path) && readFileSync(path, "utf8") === exactBytes;
        }
      },
      catch: () => "SourceUnreadable" as const,
    }),
  readForensicEvidence: (evidenceId) =>
    Effect.try({
      try: () => {
        const path = join(evidenceDir, `${evidenceId}.raw`);
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
      },
      catch: () => "SourceUnreadable" as const,
    }),
});

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
