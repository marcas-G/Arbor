import { ExecutionId, parse, WorkId } from "@arbor/domain";
import type { SandboxProcessRequest } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalWindowsSandboxProcessHostRequestV1,
  decodeCanonicalWindowsSandboxProcessHostResultV1,
  encodeWindowsSandboxProcessHostRequestV1,
  makeD4aUnavailableResultV1,
  WINDOWS_SANDBOX_PROCESS_HOST_MAX_FRAME_BYTES,
} from "../src/process-host-protocol.js";

const digest = (character: string): string => character.repeat(64);

const makeRequest = (
  overrides: Partial<SandboxProcessRequest> = {},
): SandboxProcessRequest => {
  const executionId = parse(ExecutionId)(
    "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
  );
  const handleId = "sbx_test_1";
  const mount = {
    ref: "workspace",
    rootPath: "C:\\arbor\\workspace",
    access: "ReadWrite" as const,
  };
  return {
    policy: {
      kind: "OsEnforcedProcessPolicy",
      executionId,
      episodeBinding: {
        _tag: "WorkEpisode",
        workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1"),
        targetWorkRevision: 4 as never,
      },
      sandboxHandleId: handleId,
      policyRevision: 2,
      policyDigest: digest("a"),
      admittedMounts: [mount],
      environmentAllowlist: ["HOME", "LANG", "PATH"],
      limits: {
        wallTimeMs: 10_000,
        stdoutBytes: 8192,
        stderrBytes: 4096,
        processCount: 3,
        memoryBytes: 64 * 1024 * 1024,
        cpuTimeMs: 5000,
      },
      auditRefs: [],
      profile: "WorkspaceWrite",
      providerId: "windows-restricted-appcontainer-job",
      providerVersion: "windows-t2-probe-v1",
      capabilityRevision: "1",
      enforcementRuleSetDigest: digest("b"),
      qualificationEvidenceRef: `blob:sha256:${digest("c")}`,
      boundary: "OsEnforced",
      networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
    },
    handle: {
      handleId,
      rootPath: mount.rootPath,
      mounts: [
        {
          ...mount,
          region: {} as never,
        },
      ],
      writableRegions: [],
    },
    executable: "C:\\arbor\\workspace\\bin\\tool.exe",
    args: ["--bounded"],
    cwd: { mount: "workspace", path: "." },
    timeoutMs: 10_000,
    ambientEnvironment: {
      HOME: "C:\\Users\\sandbox",
      LANG: "en_US.UTF-8",
      PATH: "C:\\Windows\\System32",
      ARBOR_SANDBOX_SECRET_SENTINEL: "must-not-cross-helper-boundary",
    },
    ...overrides,
  };
};

describe("Windows private process-host protocol D4a", () => {
  it("round-trips only the existing OsEnforced request and projected environment", () => {
    const encoded = encodeWindowsSandboxProcessHostRequestV1(makeRequest());
    const decoded = decodeCanonicalWindowsSandboxProcessHostRequestV1(encoded);

    expect(decoded).not.toBeUndefined();
    expect(decoded?.version).toBe(1);
    expect(decoded?.kind).toBe("Run");
    expect(decoded?.policy).toMatchObject({
      executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
      sandboxHandleId: "sbx_test_1",
      profile: "WorkspaceWrite",
      providerId: "windows-restricted-appcontainer-job",
      networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
      admittedMounts: [
        {
          ref: "workspace",
          rootPath: "C:\\arbor\\workspace",
          access: "ReadWrite",
        },
      ],
    });
    expect(decoded?.environment).toEqual([
      { name: "HOME", value: "C:\\Users\\sandbox" },
      { name: "LANG", value: "en_US.UTF-8" },
      { name: "PATH", value: "C:\\Windows\\System32" },
    ]);
    expect(encoded).not.toContain("ARBOR_SANDBOX_SECRET_SENTINEL");
    expect(encoded).not.toContain("must-not-cross-helper-boundary");
  });

  it("rejects unknown keys, noncanonical JSON and an oversized frame", () => {
    const encoded = encodeWindowsSandboxProcessHostRequestV1(makeRequest());
    expect(
      decodeCanonicalWindowsSandboxProcessHostRequestV1(
        encoded.replace('"kind":"Run"', '"kind":"Run","unexpected":true'),
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalWindowsSandboxProcessHostRequestV1(
        `${encoded.slice(0, -1)} `,
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalWindowsSandboxProcessHostRequestV1(
        "x".repeat(WINDOWS_SANDBOX_PROCESS_HOST_MAX_FRAME_BYTES + 1),
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalWindowsSandboxProcessHostRequestV1(
        encoded.replace("windows-restricted-appcontainer-job", "windows-mxc"),
      ),
    ).toBeUndefined();
  });

  it("rejects oversized argument lists and mismatched handle mounts before encoding", () => {
    expect(() =>
      encodeWindowsSandboxProcessHostRequestV1(
        makeRequest({ args: Array.from({ length: 257 }, () => "x") }),
      ),
    ).toThrow("InvalidRequest");
    expect(() =>
      encodeWindowsSandboxProcessHostRequestV1(
        makeRequest({
          handle: {
            handleId: "sbx_other",
            rootPath: "C:\\arbor\\workspace",
            mounts: [],
            writableRegions: [],
          },
        }),
      ),
    ).toThrow("HandleBindingMismatch");
    expect(() =>
      encodeWindowsSandboxProcessHostRequestV1(
        makeRequest({ timeoutMs: 10_001 }),
      ),
    ).toThrow("InvalidRequest");
  });

  it("keeps D4a helper replies typed Unavailable and rejects open result shapes", () => {
    const unavailable = makeD4aUnavailableResultV1();
    const encoded = JSON.stringify(unavailable);
    expect(decodeCanonicalWindowsSandboxProcessHostResultV1(encoded)).toEqual(
      unavailable,
    );
    expect(
      decodeCanonicalWindowsSandboxProcessHostResultV1(
        '{"version":1,"kind":"Result","outcome":"Completed","exitCode":0,"stdout":"","stderr":"","timedOut":false,"truncated":false,"extra":true}',
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalWindowsSandboxProcessHostResultV1(
        JSON.stringify({
          version: 1,
          kind: "Result",
          outcome: "Unavailable",
          failureCode: "MadeUpFailure",
        }),
      ),
    ).toBeUndefined();
  });
});
