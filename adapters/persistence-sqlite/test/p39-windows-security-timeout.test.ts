import { describe, expect, it } from "vitest";
import {
  isP39PathQualificationEnabled,
  isP39WindowsAclQualificationEnabled,
} from "../../../tests/support/p39-windows-deployment-test.js";
import {
  executeP39WindowsSecurityQuery,
  isP39WindowsPowerShellPathSafe,
  P39_WINDOWS_POWERSHELL_EXECUTABLE,
  P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS,
  type P39WindowsSecurityQueryExecutor,
  p39WindowsProtectedPathsScript,
  validateP39WindowsProtectedPaths,
} from "../src/p39-windows-security.js";

describe("P39 Windows security query timeout", () => {
  it("enables Windows ACL qualification only on Windows with the module available", () => {
    expect(isP39WindowsAclQualificationEnabled("linux", true)).toBe(false);
    expect(isP39WindowsAclQualificationEnabled("darwin", true)).toBe(false);
    expect(isP39WindowsAclQualificationEnabled("win32", false)).toBe(false);
    expect(isP39WindowsAclQualificationEnabled("win32", true)).toBe(true);
  });

  it("keeps cross-platform P39 suites enabled on POSIX and gates only Windows without ACL support", () => {
    expect(isP39PathQualificationEnabled("linux", false)).toBe(true);
    expect(isP39PathQualificationEnabled("darwin", false)).toBe(true);
    expect(isP39PathQualificationEnabled("win32", false)).toBe(false);
    expect(isP39PathQualificationEnabled("win32", true)).toBe(true);
  });

  it("batches volume, reparse, ACL and owner checks for every path in one query", () => {
    const paths = [
      { path: "C:\\private\\workspace", kind: "directory" as const },
      { path: "C:\\private\\workspace\\primary.sqlite", kind: "file" as const },
      { path: "C:\\private\\workspace\\writer.sqlite", kind: "file" as const },
    ];
    const script = p39WindowsProtectedPathsScript(paths);
    const calls: Array<{
      command: string;
      args: ReadonlyArray<string>;
      timeout: number;
    }> = [];
    const executor: P39WindowsSecurityQueryExecutor = (
      command,
      args,
      options,
    ) => {
      calls.push({ command, args, timeout: options.timeout });
      return "P39_PROTECTED_PATHS_OK";
    };

    expect(validateP39WindowsProtectedPaths(paths, executor)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: P39_WINDOWS_POWERSHELL_EXECUTABLE,
      args: expect.arrayContaining([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]),
      timeout: P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS,
    });
    for (const { path, kind } of paths) {
      expect(script).toContain(Buffer.from(path, "utf8").toString("base64"));
      expect(script).toContain(`Kind='${kind}'`);
    }
    expect(script).toContain("[IO.DriveInfo]::new($r)");
    expect(script).toContain("Get-Item -LiteralPath $p -Force");
    expect(script).toContain("$i.GetAccessControl()");
    expect(script).toContain(
      "$a.GetOwner([Security.Principal.SecurityIdentifier])",
    );
    expect(script).toContain("ReparsePoint");
    expect(script).toContain("S-1-5-18");
    expect(script).toContain("S-1-5-32-544");
  });

  it("uses the fixed inbox executable even when PATH contains a shadow powershell", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = `C:\\attacker-shadow${originalPath ? `;${originalPath}` : ""}`;
    let invokedCommand: string | undefined;
    try {
      const output = executeP39WindowsSecurityQuery("probe", (command) => {
        invokedCommand = command;
        return "P39_FIXED_BINARY";
      });
      expect(output).toBe("P39_FIXED_BINARY");
      expect(invokedCommand).toBe(P39_WINDOWS_POWERSHELL_EXECUTABLE);
      expect(invokedCommand).not.toBe("powershell.exe");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("fails closed when the fixed inbox binary is missing or any path component is a reparse point", () => {
    const missingFixedBinary = isP39WindowsPowerShellPathSafe({
      lstat: (path) => {
        if (path === P39_WINDOWS_POWERSHELL_EXECUTABLE) {
          throw new Error("fixed inbox binary missing");
        }
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        };
      },
      realpath: (path) => path,
    });
    const reparseAncestor = isP39WindowsPowerShellPathSafe({
      lstat: (path) => ({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => path === "C:\\Windows\\System32",
      }),
      realpath: (path) => path,
    });
    expect(missingFixedBinary).toBe(false);
    expect(reparseAncestor).toBe(false);
  });

  it("fails closed when a batched Windows security probe errors or returns an unexpected result", () => {
    const paths = [
      { path: "C:\\private\\primary.sqlite", kind: "file" as const },
    ];
    const failedExecutor: P39WindowsSecurityQueryExecutor = () => {
      throw new Error("simulated PowerShell failure");
    };
    const unexpectedExecutor: P39WindowsSecurityQueryExecutor = () =>
      "anything else";

    expect(validateP39WindowsProtectedPaths(paths, failedExecutor)).toBe(false);
    expect(validateP39WindowsProtectedPaths(paths, unexpectedExecutor)).toBe(
      false,
    );
    expect(validateP39WindowsProtectedPaths([], unexpectedExecutor)).toBe(
      false,
    );
  });

  it("keeps the shared timeout and fails closed for a timed-out batch", () => {
    let observedTimeout: number | undefined;
    const timedOutExecutor: P39WindowsSecurityQueryExecutor = (
      _command,
      _args,
      options,
    ) => {
      observedTimeout = options.timeout;
      throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
    };

    expect(
      validateP39WindowsProtectedPaths(
        [{ path: "C:\\private\\primary.sqlite", kind: "file" }],
        timedOutExecutor,
      ),
    ).toBe(false);
    expect(observedTimeout).toBe(P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS);
  });

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
