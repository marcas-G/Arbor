import { describe, expect, it } from "vitest";
import {
  cleanupProcessTreeUntilDeadline,
  runTaskkillHelperWithTimeout,
  type TaskkillHelperControl,
} from "./support/p6-process-tree-cleanup.js";

describe("P6 operator subprocess timeout cleanup", () => {
  it("bounds repeated taskkill failures by one total deadline", async () => {
    let fakeNow = 0;
    let attempts = 0;
    const result = await cleanupProcessTreeUntilDeadline({
      totalDeadlineMs: 100,
      retryDelayMs: 10,
      now: () => fakeNow,
      killTree: async (remainingMs) => {
        attempts += 1;
        fakeNow += Math.min(20, remainingMs);
        return {
          exitCode: 1,
          helperStopped: true,
          error: "fake taskkill failure",
        };
      },
      waitForDirectExit: async (remainingMs) => {
        fakeNow += Math.min(20, remainingMs);
        return false;
      },
      isRootAlive: () => true,
      sleep: async (durationMs) => {
        fakeNow += durationMs;
      },
    });
    expect(result.confirmed).toBe(false);
    expect(result.lastTaskkillExit).toBe(1);
    expect(result.lastTaskkillError).toBe("fake taskkill failure");
    expect(result.directExited).toBe(false);
    expect(result.rootAlive).toBe(true);
    expect(result.elapsedMs).toBeLessThanOrEqual(100);
    expect(attempts).toBe(result.attempts);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThan(10);
  });

  it("does not launch another taskkill while a timed-out helper is still active", async () => {
    let fakeNow = 0;
    let killTreeCalls = 0;
    const result = await cleanupProcessTreeUntilDeadline({
      totalDeadlineMs: 100,
      retryDelayMs: 10,
      now: () => fakeNow,
      killTree: async () => {
        killTreeCalls += 1;
        fakeNow += 10;
        return {
          exitCode: null,
          helperStopped: false,
          error: "fake helper termination was not confirmed",
        };
      },
      waitForDirectExit: async (remainingMs) => {
        fakeNow += remainingMs;
        return false;
      },
      isRootAlive: () => true,
      sleep: async (durationMs) => {
        fakeNow += durationMs;
      },
    });
    expect(result.confirmed).toBe(false);
    expect(result.helperStopped).toBe(false);
    expect(killTreeCalls).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it("terminates a timed-out taskkill helper and waits for its close", async () => {
    let resolveHelperExit:
      | ((value: { exitCode: number | null }) => void)
      | null = null;
    let terminateCalls = 0;
    let helperActive = true;
    const helper: TaskkillHelperControl = {
      exited: new Promise((resolveExit) => {
        resolveHelperExit = resolveExit;
      }),
      terminate: () => {
        terminateCalls += 1;
        helperActive = false;
        resolveHelperExit?.({ exitCode: null });
        return true;
      },
    };
    const result = await runTaskkillHelperWithTimeout(helper, 5, 100);
    expect(terminateCalls).toBe(1);
    expect(helperActive).toBe(false);
    expect(result.helperStopped).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("terminateRequested=true");
  });
});
