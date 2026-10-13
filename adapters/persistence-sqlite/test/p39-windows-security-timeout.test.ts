import { describe, expect, it } from "vitest";
import {
  executeP39WindowsSecurityQuery,
  P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS,
  type P39WindowsSecurityQueryExecutor,
} from "../src/p39-windows-security.js";

describe("P39 Windows security query timeout", () => {
  it("allows a simulated probe slower than 5s but below the shared bound", () => {
    let observedTimeout: number | undefined;
    const delayedExecutor: P39WindowsSecurityQueryExecutor = (
      _command,
      _args,
      options,
    ) => {
      observedTimeout = options.timeout;
      const simulatedElapsedMs = 6_000;
      if (simulatedElapsedMs >= options.timeout) {
        throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
          code: "ETIMEDOUT",
        });
      }
      return "Fixed|NTFS\n";
    };

    expect(executeP39WindowsSecurityQuery("probe", delayedExecutor)).toBe(
      "Fixed|NTFS",
    );
    expect(observedTimeout).toBe(P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS);
    expect(observedTimeout).toBe(30_000);
  });

  it("propagates timeout at the shared 30s bound for fail-closed callers", () => {
    const timedOutExecutor: P39WindowsSecurityQueryExecutor = (
      _command,
      _args,
      options,
    ) => {
      const simulatedElapsedMs = 30_000;
      if (simulatedElapsedMs >= options.timeout) {
        throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
          code: "ETIMEDOUT",
        });
      }
      return "Fixed|NTFS\n";
    };

    expect(() =>
      executeP39WindowsSecurityQuery("probe", timedOutExecutor),
    ).toThrow(/ETIMEDOUT/u);
  });
});
