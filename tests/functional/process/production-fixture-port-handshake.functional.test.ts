import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  childHasExited,
  closeServerBounded,
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

  it("stops a child once and treats a second stop as already settled", async () => {
    const child = spawn(process.execPath, [invalidChild], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    let exitEvents = 0;
    child.on("exit", () => {
      exitEvents += 1;
    });

    await stopChildBounded(child);
    await stopChildBounded(child);

    expect(childHasExited(child)).toBe(true);
    expect(exitEvents).toBe(1);
  }, 30_000);
});
