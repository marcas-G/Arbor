import type { SandboxAuthorityBundleSnapshotV3 } from "@arbor/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeWindowsSandboxProcessPort,
  WINDOWS_SANDBOX_PROVIDER_IDS,
  type WindowsSandboxProbeSnapshot,
} from "../src/index.js";

const snapshot = (
  overrides: Partial<WindowsSandboxProbeSnapshot> = {},
): WindowsSandboxProbeSnapshot => ({
  platform: "win32",
  osVersion: "10.0.19044",
  architecture: "x64",
  elevated: false,
  windowsSdkAvailable: true,
  compilerAvailable: true,
  nativeApiBridgeAvailable: true,
  secureBrokerAvailable: false,
  ...overrides,
});

describe("Windows native sandbox provider registry", () => {
  it("re-reads current V3 authority at both capability probe and run boundary without promotion", async () => {
    let reads = 0;
    let clockReads = 0;
    const evidenceRef = `blob:sha256:${"a".repeat(64)}`;
    const current = {
      _tag: "Available" as const,
      currentHost: { osFamily: "Windows" as const, osBuild: "10.0.19044" },
      snapshot: {
        bundle: {
          version: 3,
          providerRegistry: {
            entries: [
              {
                providerId:
                  WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob,
                providerVersion: "windows-t2-probe-v1",
                capabilityRevision: 1,
                osFamily: "Windows",
                osBuild: "10.0.19044",
                tuple: {
                  profile: "ReadOnly",
                  networkMode: "Disabled",
                  networkPolicyCodecVersion: 1,
                  enforcementRuleSetDigest: "b".repeat(64),
                },
                status: "Experimental",
                qualificationEvidenceRef: evidenceRef,
              },
            ],
          },
          operatorConfig: {
            limitsByProfile: [
              {
                profile: "ReadOnly",
                limits: {
                  wallTimeMs: 1,
                  stdoutBytes: 1,
                  stderrBytes: 1,
                  processCount: 1,
                  memoryBytes: 1,
                  cpuTimeMs: 1,
                },
              },
            ],
          },
        },
      } as unknown as SandboxAuthorityBundleSnapshotV3,
    };
    const provider = makeWindowsSandboxProcessPort(
      { probe: () => snapshot() },
      {
        currentAuthority: {
          loadCurrentVerifiedV2: () =>
            Effect.sync(() => {
              reads += 1;
              return current;
            }),
        },
        clock: {
          now: () =>
            Effect.sync(() => {
              clockReads += 1;
              return "2026-10-20T00:00:00.000Z";
            }),
        },
      },
    );
    const capabilities = await Effect.runPromise(provider.capabilities());
    expect(reads).toBe(1);
    expect(clockReads).toBe(1);
    expect(
      capabilities.every(
        (capability) =>
          capability.status === "Experimental" &&
          capability.profiles.length === 0,
      ),
    ).toBe(true);
    const outcome = await Effect.runPromise(
      provider.run({
        policy: {
          kind: "OsEnforcedProcessPolicy",
          executionId: "exe_1" as never,
          episodeBinding: {
            _tag: "WorkEpisode",
            workId: "wrk_1" as never,
            targetWorkRevision: 1 as never,
          },
          sandboxHandleId: "sbx_1",
          policyRevision: 1,
          profile: "ReadOnly",
          providerId: WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob,
          providerVersion: "windows-t2-probe-v1",
          capabilityRevision: "1",
          enforcementRuleSetDigest: "b".repeat(64),
          qualificationEvidenceRef: evidenceRef,
          boundary: "OsEnforced",
          networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
          policyDigest: "0".repeat(64),
          admittedMounts: [],
          environmentAllowlist: [],
          limits: {
            wallTimeMs: 1,
            stdoutBytes: 1,
            stderrBytes: 1,
            processCount: 1,
            memoryBytes: 1,
            cpuTimeMs: 1,
          },
          auditRefs: [],
        },
        handle: {
          handleId: "sbx_1",
          rootPath: "C:\\temp",
          mounts: [],
          writableRegions: [],
        },
        executable: "must-not-run.exe",
        args: [],
        cwd: { mount: "workspace", path: "." },
        timeoutMs: 1,
        ambientEnvironment: {},
      }),
    );
    expect(reads).toBe(2);
    expect(clockReads).toBe(2);
    expect(outcome._tag).toBe("Unavailable");
  });

  it("registers three distinct experimental identities without claiming support", async () => {
    const provider = makeWindowsSandboxProcessPort({ probe: () => snapshot() });
    const capabilities = await Effect.runPromise(provider.capabilities());

    expect(capabilities.map((capability) => capability.providerId)).toEqual([
      WINDOWS_SANDBOX_PROVIDER_IDS.mxc,
      WINDOWS_SANDBOX_PROVIDER_IDS.elevatedDedicatedUser,
      WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob,
    ]);
    for (const capability of capabilities) {
      expect(capability.status).toBe("Experimental");
      expect(capability.boundary).toBe("OsEnforced");
      expect(capability.profiles).toEqual([]);
      expect(capability.networkModes).toEqual([]);
      expect(capability.probeEvidenceRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it("returns typed Unavailable for every identity and never starts a process", async () => {
    const provider = makeWindowsSandboxProcessPort({ probe: () => snapshot() });
    for (const providerId of Object.values(WINDOWS_SANDBOX_PROVIDER_IDS)) {
      const outcome = await Effect.runPromise(
        provider.run({
          policy: {
            kind: "OsEnforcedProcessPolicy",
            executionId: "exe_1" as never,
            episodeBinding: {
              _tag: "WorkEpisode",
              workId: "wrk_1" as never,
              targetWorkRevision: 1 as never,
            },
            sandboxHandleId: "sbx_1",
            policyRevision: 1,
            profile: "WorkspaceWrite",
            providerId,
            providerVersion: "windows-t2-probe-v1",
            capabilityRevision: "winprobe-1",
            enforcementRuleSetDigest: "b".repeat(64),
            qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
            boundary: "OsEnforced",
            networkPolicy: {
              version: 1,
              mode: "Restricted",
              destinations: ["https://example.com:443"],
            },
            policyDigest: "0".repeat(64),
            admittedMounts: [
              {
                ref: "workspace",
                rootPath: "C:\\workspace",
                access: "ReadWrite",
              },
              {
                ref: "control-db",
                rootPath: "C:\\control-db",
                access: "ReadOnly",
              },
            ],
            environmentAllowlist: [],
            limits: {
              wallTimeMs: 1,
              stdoutBytes: 1,
              stderrBytes: 1,
              processCount: 1,
              memoryBytes: 1,
              cpuTimeMs: 1,
            },
            auditRefs: [],
          },
          handle: {
            handleId: "sbx_1",
            rootPath: "C:\\temp",
            mounts: [],
            writableRegions: [],
          },
          executable: "would-not-run.exe",
          args: [],
          cwd: { mount: "workspace", path: "." },
          timeoutMs: 1,
          ambientEnvironment: { ARBOR_SANDBOX_SENTINEL: "must-not-be-read" },
        }),
      );

      expect(outcome).toMatchObject({
        _tag: "Unavailable",
        providerId,
        providerVersion: "windows-t2-probe-v1",
        failureCode: expect.any(String),
      });
      expect(outcome._tag).toBe("Unavailable");
      expect(JSON.stringify(outcome)).not.toContain("C:\\control-db");
      expect(JSON.stringify(outcome)).not.toContain("must-not-be-read");
    }
  });

  it("reports provider-specific privilege, SDK, and primitive failures", async () => {
    const cases = [
      {
        providerId: WINDOWS_SANDBOX_PROVIDER_IDS.mxc,
        host: snapshot(),
        failureCode: "MxcPrerequisitesUnverified",
      },
      {
        providerId: WINDOWS_SANDBOX_PROVIDER_IDS.elevatedDedicatedUser,
        host: snapshot({ elevated: false }),
        failureCode: "ElevationNotVerified",
      },
      {
        providerId: WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob,
        host: snapshot({ windowsSdkAvailable: false }),
        failureCode: "WindowsSdkUnavailable",
      },
      {
        providerId: WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob,
        host: snapshot({
          nativeApiBridgeAvailable: false,
          secureBrokerAvailable: true,
        }),
        failureCode: "NativeApiBridgeUnavailable",
      },
      {
        providerId: WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob,
        host: snapshot({
          secureBrokerAvailable: true,
          admittedRootAclAvailable: true,
          reparseDefenseAvailable: true,
          jobObjectLimitsAvailable: true,
        }),
        failureCode: "NativeControlsUnqualified",
      },
    ];

    for (const testCase of cases) {
      const provider = makeWindowsSandboxProcessPort({
        probe: () => testCase.host,
      });
      const outcome = await Effect.runPromise(
        provider.run({
          policy: {
            kind: "OsEnforcedProcessPolicy",
            executionId: "exe_1" as never,
            episodeBinding: {
              _tag: "WorkEpisode",
              workId: "wrk_1" as never,
              targetWorkRevision: 1 as never,
            },
            sandboxHandleId: "sbx_1",
            policyRevision: 1,
            profile: "WorkspaceWrite",
            providerId: testCase.providerId,
            providerVersion: "windows-t2-probe-v1",
            capabilityRevision: "test",
            enforcementRuleSetDigest: "b".repeat(64),
            qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
            boundary: "OsEnforced",
            networkPolicy: {
              version: 1,
              mode: "Disabled",
              destinations: [],
            },
            policyDigest: "0".repeat(64),
            admittedMounts: [],
            environmentAllowlist: [],
            limits: {
              wallTimeMs: 1,
              stdoutBytes: 1,
              stderrBytes: 1,
              processCount: 1,
              memoryBytes: 1,
              cpuTimeMs: 1,
            },
            auditRefs: [],
          },
          handle: {
            handleId: "sbx_1",
            rootPath: "C:\\temp",
            mounts: [],
            writableRegions: [],
          },
          executable: "must-not-run.exe",
          args: [],
          cwd: { mount: "workspace", path: "." },
          timeoutMs: 1,
          ambientEnvironment: {},
        }),
      );
      expect(outcome).toMatchObject({
        _tag: "Unavailable",
        providerId: testCase.providerId,
        failureCode: testCase.failureCode,
      });
    }
  });

  it("fails closed when host, privilege, SDK, or control probes are missing", async () => {
    const missingPrerequisites = [
      snapshot({ platform: "linux" }),
      snapshot({ elevated: false }),
      snapshot({ windowsSdkAvailable: false }),
      snapshot({ nativeApiBridgeAvailable: false }),
      snapshot({ secureBrokerAvailable: false }),
    ];

    for (const host of missingPrerequisites) {
      const capabilities = await Effect.runPromise(
        makeWindowsSandboxProcessPort({
          probe: () => host,
        }).capabilities(),
      );
      expect(capabilities).toHaveLength(3);
      expect(
        capabilities.every(
          (capability) =>
            capability.status === "Experimental" &&
            capability.profiles.length === 0 &&
            capability.networkModes.length === 0,
        ),
      ).toBe(true);
    }
  });
});
