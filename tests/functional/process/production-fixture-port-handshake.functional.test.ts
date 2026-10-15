import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import {
  childHasExited,
  closeServerBounded,
  type StopChildLifecycleTestSeam,
  stopChildBounded,
} from "../support/daemon-process-lifecycle.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";

const invalidChild = resolve(
  "tests/functional/support/invalid-handshake-child.mjs",
);
const wrongPortChild = resolve(
  "tests/functional/support/wrong-port-daemon-child.mjs",
);
const processTreeParent = resolve(
  "tests/functional/support/process-tree-parent.mjs",
);
const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
});

const startFixture = (
  onDaemonStdout?: (line: string) => void,
  daemonEnvironment?: Readonly<Record<string, string>>,
) =>
  startProductionFixture({
    reply: () => "unused",
    ...(onDaemonStdout === undefined ? {} : { onDaemonStdout }),
    ...(daemonEnvironment === undefined ? {} : { daemonEnvironment }),
  });

const lifecycleReports = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line) => {
    try {
      const report = JSON.parse(line) as {
        tag?: string;
        nonce?: string;
        pid?: number;
        port?: number;
      };
      return report.tag === "FUNCTIONAL_DAEMON_STARTED" ||
        report.tag === "FUNCTIONAL_DAEMON_LISTENING"
        ? [report]
        : [];
    } catch {
      return [];
    }
  });

const fakeLifecycleProcess = (pid: number | undefined) => {
  const emitter = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: () => boolean;
  };
  Object.assign(emitter, {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => {
      emitter.killed = true;
      emitter.exitCode = 1;
      emitter.emit("exit", 1, null);
      return true;
    },
  });
  return emitter as unknown as ChildProcess;
};

const fakeTimerClock = () => {
  let now = 0;
  let nextHandle = 0;
  const timers = new Map<
    NodeJS.Timeout,
    {
      readonly dueAt: number;
      readonly callback: Parameters<typeof setTimeout>[0];
    }
  >();
  const setTimeoutFn = ((
    callback: Parameters<typeof setTimeout>[0],
    delay = 0,
  ) => {
    const handle = { id: ++nextHandle } as unknown as NodeJS.Timeout;
    timers.set(handle, { dueAt: now + Number(delay), callback });
    return handle;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((handle) => {
    timers.delete(handle as NodeJS.Timeout);
  }) as typeof clearTimeout;
  return {
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    advanceBy: (elapsedMs: number) => {
      now += elapsedMs;
      for (const [handle, timer] of [...timers]) {
        if (timer.dueAt > now) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
    pendingCount: () => timers.size,
    currentTime: () => now,
  };
};

const emitProcessExit = (child: ChildProcess, code: number) => {
  (child as unknown as { exitCode: number | null }).exitCode = code;
  child.emit("exit", code, null);
};

describe("production fixture port-zero startup handshake", () => {
  it("starts concurrent fixtures on distinct child-reported ports", async () => {
    const firstLines: string[] = [];
    const secondLines: string[] = [];
    const [first, second] = await Promise.all([
      startFixture((line) => firstLines.push(line)),
      startFixture((line) => secondLines.push(line)),
    ]);
    fixtures.push(first, second);

    const firstPort = Number(new URL(first.baseUrl).port);
    const secondPort = Number(new URL(second.baseUrl).port);
    expect(firstPort).toBeGreaterThan(0);
    expect(secondPort).toBeGreaterThan(0);
    expect(secondPort).not.toBe(firstPort);
    const startedChildren = [firstLines, secondLines].map((lines) =>
      lifecycleReports(lines).find(
        (report) => report.tag === "FUNCTIONAL_DAEMON_STARTED",
      ),
    );
    expect(startedChildren[0]?.pid).not.toBe(startedChildren[1]?.pid);
    expect(startedChildren[0]?.nonce).not.toBe(startedChildren[1]?.nonce);
    for (const lines of [firstLines, secondLines]) {
      const reports = lifecycleReports(lines);
      const started = reports.find(
        (report) => report.tag === "FUNCTIONAL_DAEMON_STARTED",
      );
      const listening = reports.find(
        (report) => report.tag === "FUNCTIONAL_DAEMON_LISTENING",
      );
      expect(started).toMatchObject({ pid: expect.any(Number) });
      expect(listening).toMatchObject({
        pid: started?.pid,
        nonce: started?.nonce,
        port: expect.any(Number),
      });
    }
  }, 180_000);

  it("reuses the first actual port after restart waits for the old child", async () => {
    const lines: string[] = [];
    const fixture = await startFixture((line) => lines.push(line));
    fixtures.push(fixture);
    const originalPort = Number(new URL(fixture.baseUrl).port);
    const originalProcess = fixture.daemonProcessSnapshot();
    if (originalProcess?.pid === undefined) {
      throw new Error("fixture daemon PID was not captured");
    }

    await fixture.restart();

    const restartedProcess = fixture.daemonProcessSnapshot();
    expect(Number(new URL(fixture.baseUrl).port)).toBe(originalPort);
    expect(restartedProcess?.requestedPort).toBe(originalPort);
    expect(restartedProcess?.pid).not.toBe(originalProcess?.pid);
    let originalPidAlive = false;
    try {
      process.kill(originalProcess.pid, 0);
      originalPidAlive = true;
    } catch {
      originalPidAlive = false;
    }
    expect(originalPidAlive).toBe(false);
    const reports = lifecycleReports(lines);
    const starts = reports.filter(
      (report) => report.tag === "FUNCTIONAL_DAEMON_STARTED",
    );
    const listening = reports.filter(
      (report) => report.tag === "FUNCTIONAL_DAEMON_LISTENING",
    );
    expect(starts).toHaveLength(2);
    expect(starts[1]?.nonce).not.toBe(starts[0]?.nonce);
    expect(listening.map((report) => report.port)).toEqual([
      originalPort,
      originalPort,
    ]);
  }, 180_000);

  it("rejects and stops a custom restart child bound to a different port", async () => {
    const lines: string[] = [];
    const fixture = await startFixture((line) => lines.push(line));
    fixtures.push(fixture);
    const requestedPort = Number(new URL(fixture.baseUrl).port);

    await expect(fixture.restart({ entry: wrongPortChild })).rejects.toThrow(
      new RegExp(`requested=${requestedPort} reported=\\d+`, "u"),
    );

    const stoppedChild = fixture.daemonProcessSnapshot();
    expect(stoppedChild?.requestedPort).toBe(requestedPort);
    expect(stoppedChild?.alive).toBe(false);
    const reports = lifecycleReports(lines);
    const listening = reports.filter(
      (report) => report.tag === "FUNCTIONAL_DAEMON_LISTENING",
    );
    expect(listening).toHaveLength(2);
    expect(listening[0]?.port).toBe(requestedPort);
    expect(listening[1]?.port).not.toBe(requestedPort);
  }, 180_000);

  it("keeps fixture stop idempotent across repeated calls", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);

    await fixture.stop();
    await expect(fixture.stop()).resolves.toBeUndefined();
    expect(fixture.daemonProcessSnapshot()?.alive).toBe(false);
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);

  it.each([
    ["wrong-pid", /invalid functional daemon start identity/u],
    ["wrong-nonce", /functional daemon listening identity mismatch/u],
    ["early-exit", /exited before listening report/u],
    ["duplicate-started", /duplicate functional daemon start marker/u],
    ["duplicate-listening", /duplicate functional daemon listening marker/u],
  ] as const)("rejects the %s child handshake", async (mode, expected) => {
    await expect(
      startProductionFixture({
        reply: () => "unused",
        firstDaemonEntry: invalidChild,
        daemonEnvironment: { ARBOR_TEST_HANDSHAKE_MODE: mode },
      }),
    ).rejects.toThrow(expected);
  });

  it("fails readiness promptly and cleans up when a listening child exits", async () => {
    let fixtureDirectory: string | undefined;
    let providerPort: number | undefined;
    let childPid: number | undefined;
    const lines: string[] = [];
    const startedAt = Date.now();

    await expect(
      startProductionFixture({
        reply: () => "unused",
        firstDaemonEntry: invalidChild,
        daemonEnvironment: {
          ARBOR_TEST_HANDSHAKE_MODE: "exit-after-listening",
        },
        onDaemonStdout: (line) => {
          lines.push(line);
          try {
            const report = JSON.parse(line) as { tag?: string; pid?: number };
            if (report.tag === "FUNCTIONAL_DAEMON_STARTED") {
              childPid = report.pid;
            }
          } catch {
            // Keep the process output as diagnostic evidence only.
          }
        },
        setupProbe: (event) => {
          fixtureDirectory = event.directory;
          providerPort = event.providerPort;
        },
      }),
    ).rejects.toThrow(
      /exited before HTTP readiness.*exitCode=23.*readiness-exit-sentinel/su,
    );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(fixtureDirectory).toBeDefined();
    expect(existsSync(fixtureDirectory ?? "")).toBe(false);
    expect(providerPort).toBeDefined();
    await expect(
      fetch(`http://127.0.0.1:${providerPort}/models`),
    ).rejects.toThrow();
    expect(childPid).toBeDefined();
    if (childPid !== undefined) {
      expect(() => process.kill(childPid as number, 0)).toThrow();
    }
    expect(lifecycleReports(lines).map((report) => report.tag)).toEqual([
      "FUNCTIONAL_DAEMON_STARTED",
      "FUNCTIONAL_DAEMON_LISTENING",
    ]);
  }, 120_000);

  it("aborts hung readiness requests within the overall deadline and cleans up", async () => {
    let fixtureDirectory: string | undefined;
    let providerPort: number | undefined;
    let childPid: number | undefined;
    const lines: string[] = [];
    const timeoutMs = 1_500;
    const startedAt = Date.now();

    await expect(
      startProductionFixture({
        reply: () => "unused",
        firstDaemonEntry: invalidChild,
        daemonEnvironment: { ARBOR_TEST_HANDSHAKE_MODE: "hang-readiness" },
        daemonReadinessTimeoutMs: timeoutMs,
        onDaemonStdout: (line) => {
          lines.push(line);
          try {
            const report = JSON.parse(line) as { tag?: string; pid?: number };
            if (report.tag === "FUNCTIONAL_DAEMON_STARTED") {
              childPid = report.pid;
            }
          } catch {
            // Keep the process output as diagnostic evidence only.
          }
        },
        setupProbe: (event) => {
          fixtureDirectory = event.directory;
          providerPort = event.providerPort;
        },
      }),
    ).rejects.toThrow(
      /functional daemon HTTP readiness timed out after 1500ms/u,
    );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(
      lines.some((line) =>
        line.includes("FUNCTIONAL_DAEMON_READINESS_REQUEST"),
      ),
    ).toBe(true);
    expect(fixtureDirectory).toBeDefined();
    expect(existsSync(fixtureDirectory ?? "")).toBe(false);
    expect(providerPort).toBeDefined();
    await expect(
      fetch(`http://127.0.0.1:${providerPort}/models`),
    ).rejects.toThrow();
    expect(childPid).toBeDefined();
    if (childPid !== undefined) {
      expect(() => process.kill(childPid as number, 0)).toThrow();
    }
  }, 120_000);

  it("rejects HTTP success that arrives after the overall readiness deadline", async () => {
    let fixtureDirectory: string | undefined;
    let providerPort: number | undefined;
    let childPid: number | undefined;
    let unexpectedFixture:
      | Awaited<ReturnType<typeof startProductionFixture>>
      | undefined;
    let startupError: unknown;
    const lines: string[] = [];
    const timeoutMs = 1_500;
    const startedAt = Date.now();

    try {
      unexpectedFixture = await startProductionFixture({
        reply: () => "unused",
        firstDaemonEntry: invalidChild,
        daemonEnvironment: { ARBOR_TEST_HANDSHAKE_MODE: "late-readiness" },
        daemonReadinessTimeoutMs: timeoutMs,
        // Deliberately ignore the request AbortSignal so the fixture must also
        // reject a late 200 after the absolute readiness deadline.
        daemonReadinessFetch: (input) => fetch(input),
        onDaemonStdout: (line) => {
          lines.push(line);
          try {
            const report = JSON.parse(line) as { tag?: string; pid?: number };
            if (report.tag === "FUNCTIONAL_DAEMON_STARTED") {
              childPid = report.pid;
            }
          } catch {
            // Keep the process output as diagnostic evidence only.
          }
        },
        setupProbe: (event) => {
          fixtureDirectory = event.directory;
          providerPort = event.providerPort;
        },
      });
    } catch (error) {
      startupError = error;
    }

    if (unexpectedFixture !== undefined) await unexpectedFixture.stop();
    expect(startupError).toBeInstanceOf(Error);
    expect(String(startupError)).toContain(
      `functional daemon HTTP readiness timed out after ${timeoutMs}ms`,
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(timeoutMs);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(
      lines.some((line) =>
        line.includes("FUNCTIONAL_DAEMON_READINESS_RESPONSE"),
      ),
    ).toBe(true);
    expect(fixtureDirectory).toBeDefined();
    expect(existsSync(fixtureDirectory ?? "")).toBe(false);
    expect(providerPort).toBeDefined();
    await expect(
      fetch(`http://127.0.0.1:${providerPort}/models`),
    ).rejects.toThrow();
    expect(childPid).toBeDefined();
    if (childPid !== undefined) {
      expect(() => process.kill(childPid as number, 0)).toThrow();
    }
  }, 120_000);

  it("bounds provider close when it hangs or throws", async () => {
    let forcedHangClose = 0;
    const hangingServer = {
      listening: true,
      close: (_callback: (error?: Error) => void) => undefined,
      closeAllConnections: () => {
        forcedHangClose += 1;
      },
    } as unknown as Server;
    await expect(closeServerBounded(hangingServer, 10)).rejects.toThrow(
      "HTTP server did not close within 10ms",
    );
    expect(forcedHangClose).toBe(1);

    let forcedThrowClose = 0;
    const throwingServer = {
      listening: true,
      close: () => {
        throw new Error("injected provider close failure");
      },
      closeAllConnections: () => {
        forcedThrowClose += 1;
      },
    } as unknown as Server;
    await expect(closeServerBounded(throwingServer, 10)).rejects.toThrow(
      "injected provider close failure",
    );
    expect(forcedThrowClose).toBe(1);
  });

  it("waits a fresh target-exit grace after delayed taskkill completion", async () => {
    const target = fakeLifecycleProcess(41_001);
    const killer = fakeLifecycleProcess(41_002);
    const clock = fakeTimerClock();
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      taskkillTimeoutMs: 10_000,
      spawnTaskkill: () => killer,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    clock.advanceBy(5_100);
    expect(clock.currentTime()).toBeGreaterThan(5_000);
    emitProcessExit(killer, 0);
    await new Promise<void>((resolveImmediate) =>
      setImmediate(resolveImmediate),
    );
    expect(childHasExited(target)).toBe(false);

    emitProcessExit(target, 0);
    await expect(stopped).resolves.toBeUndefined();
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("error")).toBe(0);
  });

  it("waits for successful tree cleanup when the target exits first", async () => {
    const target = fakeLifecycleProcess(41_101);
    const killer = fakeLifecycleProcess(41_102);
    let descendantAlive = true;
    const clock = fakeTimerClock();
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      naturalExitGraceMs: 0,
      spawnTaskkill: () => {
        setImmediate(() => {
          emitProcessExit(target, 0);
          setImmediate(() => emitProcessExit(killer, 0));
        });
        return killer;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    setImmediate(() => {
      descendantAlive = false;
    });
    await expect(stopped).resolves.toBeUndefined();

    expect(killer.killed).toBe(false);
    expect(childHasExited(killer)).toBe(true);
    expect(descendantAlive).toBe(false);
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("error")).toBe(0);
  });

  it("waits for a pid-less taskkill helper to spawn and finish successfully", async () => {
    const target = fakeLifecycleProcess(41_201);
    const killer = fakeLifecycleProcess(undefined);
    const clock = fakeTimerClock();
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      naturalExitGraceMs: 0,
      spawnTaskkill: () => {
        setImmediate(() => emitProcessExit(target, 0));
        return killer;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    let settled = false;
    const stopped = stopChildBounded(target, 5_000, seam).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolveImmediate) =>
      setImmediate(resolveImmediate),
    );
    expect(settled).toBe(false);

    (killer as unknown as { pid: number }).pid = 41_202;
    killer.emit("spawn");
    await new Promise<void>((resolveImmediate) =>
      setImmediate(resolveImmediate),
    );
    emitProcessExit(killer, 0);
    await expect(stopped).resolves.toBeUndefined();
    expect(killer.killed).toBe(false);
    expect(childHasExited(killer)).toBe(true);
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("spawn")).toBe(0);
    expect(killer.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("error")).toBe(0);
  });

  it("rejects when a pid-less taskkill helper errors after target-first exit", async () => {
    const target = fakeLifecycleProcess(41_301);
    const killer = fakeLifecycleProcess(undefined);
    const clock = fakeTimerClock();
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      naturalExitGraceMs: 0,
      spawnTaskkill: () => {
        setImmediate(() => {
          emitProcessExit(target, 0);
          setImmediate(() =>
            killer.emit("error", new Error("injected delayed spawn failure")),
          );
        });
        return killer;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    await expect(stopped).rejects.toThrow(
      /Windows process-tree cleanup unproven; attempt phases=taskkill-1-target-first-error/u,
    );
    expect(killer.killed).toBe(false);
    expect(killer.listenerCount("spawn")).toBe(0);
    expect(killer.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("error")).toBe(0);
    expect(clock.pendingCount()).toBe(0);
  });

  it("rejects when target-first taskkill exits nonzero", async () => {
    const target = fakeLifecycleProcess(41_351);
    const killer = fakeLifecycleProcess(41_352);
    const clock = fakeTimerClock();
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      naturalExitGraceMs: 0,
      spawnTaskkill: () => {
        setImmediate(() => {
          emitProcessExit(target, 0);
          setImmediate(() => emitProcessExit(killer, 5));
        });
        return killer;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    await expect(stopped).rejects.toThrow(
      /Windows process-tree cleanup unproven; attempt phases=taskkill-1-target-first-exit \(taskkill exit code=5/u,
    );
    expect(childHasExited(target)).toBe(true);
    expect(childHasExited(killer)).toBe(true);
    expect(killer.killed).toBe(false);
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("exit")).toBe(0);
  });

  it("returns without taskkill when a live Windows child exits during natural grace", async () => {
    const target = fakeLifecycleProcess(41_361);
    const clock = fakeTimerClock();
    let taskkillCalls = 0;
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      naturalExitGraceMs: 750,
      spawnTaskkill: () => {
        taskkillCalls += 1;
        return fakeLifecycleProcess(41_362);
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    emitProcessExit(target, 0);
    await expect(stopped).resolves.toBeUndefined();
    expect(taskkillCalls).toBe(0);
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
  });

  it("rejects taskkill code 128 after forced cleanup has started", async () => {
    const target = fakeLifecycleProcess(41_371);
    const killer = fakeLifecycleProcess(41_372);
    const clock = fakeTimerClock();
    let taskkillCalls = 0;
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      naturalExitGraceMs: 750,
      spawnTaskkill: () => {
        taskkillCalls += 1;
        setImmediate(() => {
          emitProcessExit(target, 0);
          setImmediate(() => emitProcessExit(killer, 128));
        });
        return killer;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    clock.advanceBy(750);
    await expect(stopped).rejects.toThrow(
      /Windows process-tree cleanup unproven; attempt phases=taskkill-1-target-first-exit/u,
    );
    expect(taskkillCalls).toBe(1);
    expect(childHasExited(target)).toBe(true);
    expect(childHasExited(killer)).toBe(true);
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("exit")).toBe(0);
  });

  it("accepts code 0 only when forced taskkill exits the target", async () => {
    const target = fakeLifecycleProcess(41_381);
    const killer = fakeLifecycleProcess(41_382);
    const clock = fakeTimerClock();
    let taskkillCalls = 0;
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      naturalExitGraceMs: 750,
      spawnTaskkill: () => {
        taskkillCalls += 1;
        setImmediate(() => {
          emitProcessExit(killer, 0);
          setImmediate(() => emitProcessExit(target, 0));
        });
        return killer;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    clock.advanceBy(750);
    await expect(stopped).resolves.toBeUndefined();
    expect(taskkillCalls).toBe(1);
    expect(childHasExited(target)).toBe(true);
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("exit")).toBe(0);
  });

  it.skipIf(process.platform !== "win32")(
    "does not spawn taskkill when a real Windows root exits during natural grace",
    async () => {
      const root = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        root.once("spawn", resolveSpawn);
        root.once("error", rejectSpawn);
      });
      let taskkillCalls = 0;
      const stop = stopChildBounded(root, 5_000, {
        platform: "win32",
        naturalExitGraceMs: 500,
        spawnTaskkill: () => {
          taskkillCalls += 1;
          return fakeLifecycleProcess(41_392);
        },
      });
      setTimeout(() => root.kill("SIGTERM"), 50);
      await expect(stop).resolves.toBeUndefined();
      expect(taskkillCalls).toBe(0);
      expect(childHasExited(root)).toBe(true);
      await expect(
        stopChildBounded(root, 5_000, { platform: "win32" }),
      ).resolves.toBeUndefined();
    },
    30_000,
  );

  it("retries a timed-out tree kill and verifies the retry removes the tree", async () => {
    const target = fakeLifecycleProcess(41_401);
    const primary = fakeLifecycleProcess(41_402);
    const retry = fakeLifecycleProcess(41_403);
    const clock = fakeTimerClock();
    let descendantAlive = true;
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      taskkillTimeoutMs: 10_000,
      spawnTaskkill: (_pid, attempt) => {
        if (attempt === 1) return primary;
        setImmediate(() => {
          emitProcessExit(retry, 0);
          setImmediate(() => {
            descendantAlive = false;
            emitProcessExit(target, 0);
          });
        });
        return retry;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    clock.advanceBy(10_000);
    await expect(stopped).resolves.toBeUndefined();
    expect(primary.killed).toBe(true);
    expect(childHasExited(primary)).toBe(true);
    expect(childHasExited(retry)).toBe(true);
    expect(childHasExited(target)).toBe(true);
    expect(descendantAlive).toBe(false);
    expect(clock.pendingCount()).toBe(0);
  });

  it("falls back and rejects as unproven when both tree kills fail", async () => {
    const target = fakeLifecycleProcess(41_501);
    const primary = fakeLifecycleProcess(41_502);
    const retry = fakeLifecycleProcess(41_503);
    const clock = fakeTimerClock();
    const descendantAlive = true;
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      taskkillTimeoutMs: 10_000,
      spawnTaskkill: (_pid, attempt) => {
        if (attempt === 1) return primary;
        setImmediate(() => emitProcessExit(retry, 1));
        return retry;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    clock.advanceBy(10_000);
    await expect(stopped).rejects.toThrow(
      /Windows process-tree cleanup unproven; attempt phases=.*fallback-direct-child-SIGKILL.*fallback-direct-child-exit-confirmed/u,
    );
    expect(primary.killed).toBe(true);
    expect(childHasExited(primary)).toBe(true);
    expect(childHasExited(retry)).toBe(true);
    expect(childHasExited(target)).toBe(true);
    expect(descendantAlive).toBe(true);
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
    expect(primary.listenerCount("exit")).toBe(0);
    expect(retry.listenerCount("exit")).toBe(0);
  });

  it("keeps a failed tree cleanup unproven when the root exits during helper cleanup", async () => {
    const target = fakeLifecycleProcess(41_601);
    const primary = fakeLifecycleProcess(41_602);
    const primaryMutable = primary as unknown as {
      killed: boolean;
      kill: () => boolean;
    };
    primaryMutable.kill = () => {
      primaryMutable.killed = true;
      return true;
    };
    const clock = fakeTimerClock();
    const descendantAlive = true;
    let spawnAttempts = 0;
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      taskkillTimeoutMs: 10_000,
      taskkillCleanupTimeoutMs: 500,
      spawnTaskkill: () => {
        spawnAttempts += 1;
        return primary;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 5_000, seam);
    clock.advanceBy(10_000);
    await new Promise<void>((resolveImmediate) =>
      setImmediate(resolveImmediate),
    );
    expect(primaryMutable.killed).toBe(true);
    expect(childHasExited(target)).toBe(false);

    emitProcessExit(target, 0);
    emitProcessExit(primary, 1);
    let firstFailure = "";
    try {
      await stopped;
    } catch (error) {
      firstFailure = error instanceof Error ? error.message : String(error);
    }

    expect(firstFailure).toContain("Windows process-tree cleanup unproven");
    expect(firstFailure).toContain(
      "target-exited-after-failed-taskkill-1; tree-cleanup-unproven",
    );
    expect(spawnAttempts).toBe(1);
    expect(descendantAlive).toBe(true);
    expect(childHasExited(target)).toBe(true);
    expect(childHasExited(primary)).toBe(true);
    expect(clock.pendingCount()).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
    expect(primary.listenerCount("exit")).toBe(0);

    await expect(stopChildBounded(target, 5_000, seam)).rejects.toThrow(
      firstFailure,
    );
    expect(spawnAttempts).toBe(1);
    expect(descendantAlive).toBe(true);
  });

  it("keeps an already-exited, never-stopped child as the existing no-op", async () => {
    const target = fakeLifecycleProcess(41_701);
    emitProcessExit(target, 0);
    let spawnAttempts = 0;
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      spawnTaskkill: () => {
        spawnAttempts += 1;
        return fakeLifecycleProcess(41_702);
      },
    };

    await expect(
      stopChildBounded(target, 5_000, seam),
    ).resolves.toBeUndefined();
    expect(spawnAttempts).toBe(0);
  });

  it("kills and reaps taskkill on its independent timeout", async () => {
    const target = fakeLifecycleProcess(42_001);
    const killer = fakeLifecycleProcess(42_002);
    const clock = fakeTimerClock();
    const seam: StopChildLifecycleTestSeam = {
      platform: "win32",
      taskkillTimeoutMs: 6_000,
      taskkillCleanupTimeoutMs: 500,
      spawnTaskkill: () => killer,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const stopped = stopChildBounded(target, 2_000, seam);
    clock.advanceBy(6_000);
    await expect(stopped).rejects.toThrow(
      /Windows process-tree cleanup unproven; attempt phases=taskkill-1-timeout/u,
    );

    expect(killer.killed).toBe(true);
    expect(childHasExited(killer)).toBe(true);
    expect(target.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("error")).toBe(0);
    expect(clock.pendingCount()).toBe(0);
  });

  it.skipIf(process.platform !== "win32")(
    "stops a real Windows process tree and remains safe on repeated stop",
    async () => {
      const parent = spawn(process.execPath, [processTreeParent], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      if (parent.stdout === null) {
        throw new Error("process-tree helper stdout is required");
      }
      const lines = createInterface({ input: parent.stdout });
      try {
        const grandchildPid = await new Promise<number>(
          (resolveReady, rejectReady) => {
            parent.once("error", rejectReady);
            lines.once("line", (line) => {
              try {
                const report = JSON.parse(line) as {
                  readonly tag?: string;
                  readonly grandchildPid?: number;
                };
                if (
                  report.tag !== "PROCESS_TREE_READY" ||
                  typeof report.grandchildPid !== "number"
                ) {
                  rejectReady(
                    new Error("process-tree helper emitted invalid readiness"),
                  );
                  return;
                }
                resolveReady(report.grandchildPid);
              } catch (error) {
                rejectReady(error);
              }
            });
          },
        );
        await stopChildBounded(parent);
        await stopChildBounded(parent);
        expect(childHasExited(parent)).toBe(true);
        expect(() => process.kill(grandchildPid, 0)).toThrow();
      } finally {
        await stopChildBounded(parent).catch(() => undefined);
        lines.close();
      }
    },
    30_000,
  );
});
