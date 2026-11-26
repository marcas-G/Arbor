import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxProcessRequest } from "@arbor/ports";
import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeNativePosixSandboxProcessPort } from "../../src/index.js";
import {
  handleFor,
  makeRoot,
  policyFor,
  qualifiedLinuxProvider,
} from "./support.js";

describe("native POSIX sandbox policy plans", () => {
  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "stops the process tree before returning a failed output-overflow result",
    async () => {
      const root = makeRoot();
      const base = policyFor(root);
      const result = await Effect.runPromise(
        qualifiedLinuxProvider().run({
          policy: {
            ...base,
            limits: { ...base.limits, stdoutBytes: 128, processCount: 8 },
          },
          handle: handleFor(root),
          executable: "bash",
          args: [
            "-lc",
            "dd if=/dev/zero bs=100000 count=1 status=none; sleep 1; printf orphaned > after-return.txt",
          ],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 5000,
          ambientEnvironment: {},
        }),
      );
      expect(result).toMatchObject({ _tag: "Completed", truncated: true });
      if (result._tag !== "Completed") return;
      // A truncated capture of a normally completed command can be successful.
      // Here the supervisor client was killed by maxBuffer before shell exit.
      expect(result.exitCode).not.toBe(0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
      expect(existsSync(join(root, "work", "after-return.txt"))).toBe(false);
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "interrupting a native invocation stops descendants before interruption finishes",
    async () => {
      const root = makeRoot();
      const base = policyFor(root);
      const fiber = Effect.runFork(
        qualifiedLinuxProvider().run({
          policy: { ...base, limits: { ...base.limits, processCount: 8 } },
          handle: handleFor(root),
          executable: "bash",
          args: [
            "-lc",
            "cat /proc/self/cgroup > group.txt; (sleep 1; printf orphaned > after-interrupt.txt) & printf ready > ready.txt; wait",
          ],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 5000,
          ambientEnvironment: {},
        }),
      );
      try {
        await vi.waitFor(
          () => expect(existsSync(join(root, "work", "ready.txt"))).toBe(true),
          { timeout: 4000, interval: 20 },
        );
        await Effect.runPromise(Fiber.interrupt(fiber));
        const group = readFileSync(join(root, "work", "group.txt"), "utf8")
          .trim()
          .split("0::")[1];
        expect(group).toContain("arbor-sandbox-");
        const events = `/sys/fs/cgroup${group}/cgroup.events`;
        if (existsSync(events))
          expect(readFileSync(events, "utf8")).toContain("populated 0");
        await new Promise((resolveWait) => setTimeout(resolveWait, 1250));
        expect(existsSync(join(root, "work", "after-interrupt.txt"))).toBe(
          false,
        );
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "interrupts A without stopping a simultaneous isolated invocation B",
    async () => {
      const first = makeRoot();
      const second = makeRoot();
      const provider = qualifiedLinuxProvider();
      const run = (root: string) => {
        const base = policyFor(root);
        return Effect.runFork(
          provider.run({
            policy: { ...base, limits: { ...base.limits, processCount: 8 } },
            handle: handleFor(root),
            executable: "bash",
            args: [
              "-lc",
              "printf ready > ready.txt; sleep 2; printf finished > finished.txt",
            ],
            cwd: { mount: "workspace", path: "work" },
            timeoutMs: 5000,
            ambientEnvironment: {},
          }),
        );
      };
      const a = run(first);
      const b = run(second);
      try {
        await vi.waitFor(
          () => {
            expect(existsSync(join(first, "work", "ready.txt"))).toBe(true);
            expect(existsSync(join(second, "work", "ready.txt"))).toBe(true);
          },
          { timeout: 4000, interval: 20 },
        );
        await Effect.runPromise(Fiber.interrupt(a));
        expect(await Effect.runPromise(Fiber.join(b))).toMatchObject({
          _tag: "Completed",
          exitCode: 0,
        });
        expect(readFileSync(join(second, "work", "finished.txt"), "utf8")).toBe(
          "finished",
        );
        expect(existsSync(join(first, "work", "finished.txt"))).toBe(false);
      } finally {
        await Effect.runPromise(Fiber.interrupt(a));
        await Effect.runPromise(Fiber.interrupt(b));
      }
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "executes a real disabled-network process under systemd and bubblewrap",
    async () => {
      const root = makeRoot();
      const request: SandboxProcessRequest = {
        policy: { ...policyFor(root), providerId: "linux-bwrap" },
        handle: handleFor(root),
        executable: "bash",
        args: [
          "-lc",
          "printf native-ok; printf created > created.txt; test -f created.txt",
        ],
        cwd: { mount: "workspace", path: "work" },
        timeoutMs: 5000,
        ambientEnvironment: process.env,
      };
      const provider = makeNativePosixSandboxProcessPort({
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
          networkModes: ["Disabled"],
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
      const outcome = await Effect.runPromise(provider.run(request));
      expect(outcome).toMatchObject({ _tag: "Completed", exitCode: 0 });
      expect(outcome).toMatchObject({ stdout: "native-ok" });
      expect(readFileSync(join(root, "work", "created.txt"), "utf8")).toBe(
        "created",
      );
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "keeps host data, network and ambient secrets outside the real process boundary",
    async () => {
      const root = makeRoot();
      const hostOnly = join(
        process.env.HOME ?? "/home",
        `.arbor-native-host-only-${process.pid}`,
      );
      writeFileSync(hostOnly, "host-only");
      try {
        const request: SandboxProcessRequest = {
          policy: { ...policyFor(root), providerId: "linux-bwrap" },
          handle: handleFor(root),
          executable: "/bin/bash",
          args: [
            "-lc",
            'test ! -r /etc/passwd && test ! -r "$1" && test -z "$ARBOR_NATIVE_SECRET" && if (exec 3<>/dev/tcp/1.1.1.1/80); then exit 41; else exit 0; fi',
            "arbor-native-boundary",
            hostOnly,
          ],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 5000,
          ambientEnvironment: {
            ...process.env,
            ARBOR_NATIVE_HOST_ONLY: hostOnly,
            ARBOR_NATIVE_SECRET: "must-not-reach-child",
          },
        };
        const outcome = await Effect.runPromise(
          qualifiedLinuxProvider().run(request),
        );
        expect(outcome).toMatchObject({ _tag: "Completed", exitCode: 0 });
      } finally {
        rmSync(hostOnly, { force: true });
      }
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "enforces output and wall-time limits through the real process supervisor",
    async () => {
      const root = makeRoot();
      const basePolicy = policyFor(root);
      const outputRequest: SandboxProcessRequest = {
        policy: {
          ...basePolicy,
          providerId: "linux-bwrap",
          limits: { ...basePolicy.limits, stdoutBytes: 128 },
        },
        handle: handleFor(root),
        executable: "/bin/bash",
        args: ["-lc", "head -c 10000 /dev/zero | tr '\\0' x"],
        cwd: { mount: "workspace", path: "work" },
        timeoutMs: 5000,
        ambientEnvironment: process.env,
      };
      const output = await Effect.runPromise(
        qualifiedLinuxProvider().run(outputRequest),
      );
      expect(output, JSON.stringify(output)).toMatchObject({
        _tag: "Completed",
        truncated: true,
      });
      if (output._tag === "Completed")
        expect(output.stdout.length).toBeLessThanOrEqual(128);

      const timeoutRequest: SandboxProcessRequest = {
        ...outputRequest,
        policy: {
          ...outputRequest.policy,
          limits: { ...outputRequest.policy.limits, wallTimeMs: 1000 },
        },
        args: ["-lc", "sleep 30"],
        timeoutMs: 1000,
      };
      const timeout = await Effect.runPromise(
        qualifiedLinuxProvider().run(timeoutRequest),
      );
      expect(timeout).toMatchObject({ _tag: "Completed", timedOut: true });
    },
  );
});
