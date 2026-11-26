import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TrustedLocalProcessPort,
  type TrustedLocalProcessRequest,
} from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { TrustedLocalProcessPortLive } from "../src/trusted-local-process.js";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const requestFor = (rootPath: string): TrustedLocalProcessRequest => {
  const root = realpathSync(rootPath);
  return {
    policy: {
      kind: "TrustedLocalUnconfinedRuntimePolicy",
      executionId: "exe_test" as never,
      episodeBinding: {
        _tag: "WorkEpisode",
        workId: "work_test" as never,
        targetWorkRevision: 1 as never,
      },
      sandboxHandleId: "sbx_exe_test",
      policyRevision: 1,
      profile: "FullAccess",
      providerId: "TrustedLocal",
      providerVersion: "builtin-v1",
      capabilityRevision: "builtin-v1",
      boundary: "TrustedLocal",
      trustedRuntimeIdentity: "TrustedLocal",
      trustedRuntimeVersion: "builtin-v1",
      networkBoundary: "Unconfined",
      policyDigest: "a".repeat(64),
      admittedMounts: [
        { ref: "workspace", rootPath: root, access: "ReadWrite" },
      ],
      environmentAllowlist: ["PATH"],
      limits: {
        wallTimeMs: 5000,
        stdoutBytes: 1024,
        stderrBytes: 1024,
        processCount: 1,
        memoryBytes: 1_000_000,
        cpuTimeMs: 5000,
      },
      auditRefs: ["cmd_test"],
    },
    handle: {
      handleId: "sbx_exe_test",
      rootPath: root,
      mounts: [
        {
          ref: "workspace",
          rootPath: root,
          region: {
            resourceSpaceId: "filesystem",
            normalizedRegion: { kind: "FileTree", path: root },
          },
          access: "ReadWrite",
        },
      ],
      writableRegions: [],
    },
    executable: process.execPath,
    args: ["-e", "process.stdout.write('trusted-local-ok')"],
    cwd: { mount: "workspace", path: "." },
    timeoutMs: 5000,
    ambientEnvironment: process.env,
  };
};

describe("TrustedLocalProcessPort", () => {
  it.effect(
    "executes the explicit unconfined local branch through the adapter",
    () =>
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "arbor-trusted-local-"));
        roots.push(directory);
        const mountRoot = join(directory, "workspace");
        mkdirSync(mountRoot);
        const port = yield* TrustedLocalProcessPort;
        const result = yield* port.run(requestFor(mountRoot));
        expect(result).toMatchObject({
          _tag: "Completed",
          exitCode: 0,
          stdout: "trusted-local-ok",
          timedOut: false,
        });
      }).pipe(Effect.provide(TrustedLocalProcessPortLive)),
  );

  it.effect(
    "rejects a read-only cwd mount and a cwd that escapes its logical mount",
    () =>
      Effect.gen(function* () {
        const directory = mkdtempSync(
          join(tmpdir(), "arbor-trusted-local-reject-"),
        );
        roots.push(directory);
        const mountRoot = join(directory, "workspace");
        mkdirSync(mountRoot);
        const base = requestFor(mountRoot);
        const mounts = base.handle.mounts;
        if (mounts === undefined) throw new Error("test handle has no mounts");
        const testRequest = (request: TrustedLocalProcessRequest) =>
          Effect.gen(function* () {
            const port = yield* TrustedLocalProcessPort;
            return yield* port.run(request);
          }).pipe(Effect.provide(TrustedLocalProcessPortLive));
        const readonly = yield* testRequest({
          ...base,
          handle: {
            ...base.handle,
            mounts: mounts.map((mount) => ({
              ...mount,
              access: "ReadOnly" as const,
            })),
          },
        });
        const escaped = yield* testRequest({
          ...base,
          cwd: { mount: "workspace", path: "../outside" },
        });
        expect(readonly).toMatchObject({
          _tag: "Rejected",
          failureCode: "ProcessCapabilityNotBound",
        });
        expect(escaped).toMatchObject({
          _tag: "Rejected",
          failureCode: "ProcessCapabilityNotBound",
        });
      }),
  );
});
