import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OsEnforcedSandboxProcessPolicy } from "@arbor/ports";
import { afterEach } from "vitest";
import {
  makeNativePosixSandboxProcessPort,
  type NativePosixSandboxOptions,
} from "../../src/index.js";

export const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

export const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "arbor-native-posix-test-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "work"));
  return root;
};

export const policyFor = (root: string): OsEnforcedSandboxProcessPolicy => ({
  kind: "OsEnforcedProcessPolicy",
  executionId: "exe_test" as OsEnforcedSandboxProcessPolicy["executionId"],
  episodeBinding: {
    _tag: "WorkEpisode",
    workId: "work_test" as never,
    targetWorkRevision: 1 as never,
  },
  sandboxHandleId: "sandbox_test",
  policyRevision: 1,
  profile: "WorkspaceWrite",
  providerId: "linux-bwrap",
  providerVersion: "qualified-v1",
  capabilityRevision: "qualified-v1",
  enforcementRuleSetDigest: "b".repeat(64),
  qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
  boundary: "OsEnforced",
  networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
  policyDigest: "a".repeat(64),
  admittedMounts: [
    { ref: "workspace", rootPath: realpathSync(root), access: "ReadWrite" },
  ],
  environmentAllowlist: ["PATH", "LANG"],
  limits: {
    wallTimeMs: 10_000,
    stdoutBytes: 1024,
    stderrBytes: 1024,
    processCount: 4,
    memoryBytes: 64 * 1024 * 1024,
    cpuTimeMs: 10_000,
  },
  auditRefs: [],
});

export const handleFor = (root: string) => ({
  handleId: "sandbox_test",
  rootPath: realpathSync(root),
  mounts: [
    {
      ref: "workspace",
      rootPath: realpathSync(root),
      region: {} as never,
      access: "ReadWrite" as const,
    },
  ],
  writableRegions: [],
});

export const qualifiedLinuxProvider = (
  options: Pick<NativePosixSandboxOptions, "networkBrokerFactory"> = {},
) =>
  makeNativePosixSandboxProcessPort({
    ...options,
    platform: "linux",
    linuxProbe: async () => ({
      providerId: "linux-bwrap",
      providerVersion: "qualified-v1",
      capabilityRevision: "qualified-v1",
      probeEvidenceRef: "sha256:qualified",
      enforcementRuleSetDigest: "b".repeat(64),
      qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
      status: "Supported",
      boundary: "OsEnforced",
      profiles: ["WorkspaceWrite"],
      networkModes: ["Disabled", "Enabled"],
      failureCode: null,
      prerequisites: {},
    }),
    seatbeltProbe: async () => ({
      providerId: "macos-seatbelt",
      providerVersion: "experimental-v1",
      capabilityRevision: "test",
      probeEvidenceRef: null,
      enforcementRuleSetDigest: null,
      qualificationEvidenceRef: null,
      status: "Experimental",
      boundary: "OsEnforced",
      profiles: [],
      networkModes: [],
      failureCode: "UnsupportedPlatform",
      prerequisites: {},
    }),
  });
