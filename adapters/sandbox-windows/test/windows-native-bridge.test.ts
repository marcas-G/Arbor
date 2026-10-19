import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const nativeSourceDirectory = join(testDirectory, "native");
const helperSource = join(
  nativeSourceDirectory,
  "WindowsSandboxBridgeHarness.cs",
);
const childSource = join(nativeSourceDirectory, "WindowsSandboxChild.cs");
const expectedSourceDigests = {
  "WindowsSandboxBridgeHarness.cs":
    "aefa0bed85c3a8b4ae11af92f29ad2e20cb3006b8424b1ebf89c5c2ccb96c709",
  "WindowsSandboxChild.cs":
    "ae4e8d60e18206407938013e7005c79ef813054bdd512b16204a84ca7d3231b1",
} as const;

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const parseOutput = (value: string): Readonly<Record<string, string>> => {
  const entries = value.split(/\r?\n/u).map((line) => {
    const index = line.indexOf("=");
    return index > 0
      ? ([line.slice(0, index), line.slice(index + 1)] as const)
      : undefined;
  });
  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
};

describe.skipIf(process.platform !== "win32")(
  "Windows native bridge T3-A checkpoint",
  () => {
    let buildDirectory = "";
    let bridgeExecutable = "";
    let childExecutable = "";

    const run = (
      mode: string,
      options: {
        readonly walltimeMs?: number;
        readonly stdoutBytes?: number;
        readonly stderrBytes?: number;
        readonly processCount?: number;
        readonly memoryBytes?: number;
      } = {},
    ): Readonly<Record<string, string>> => {
      let stdout: string;
      try {
        stdout = execFileSync(
          bridgeExecutable,
          [
            "launch",
            childExecutable,
            mode,
            String(options.walltimeMs ?? 10000),
            String(options.stdoutBytes ?? 8192),
            String(options.stderrBytes ?? 8192),
            String(options.processCount ?? 4),
            String(options.memoryBytes ?? 256 * 1024 * 1024),
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30000,
            maxBuffer: 128 * 1024,
            env: {
              ...process.env,
              ARBOR_SANDBOX_SENTINEL: "must-not-cross-the-boundary",
            },
          },
        );
      } catch (error) {
        const child = error as {
          readonly stdout?: Buffer;
          readonly stderr?: Buffer;
        };
        throw new Error(
          `native bridge launch failed: ${child.stdout?.toString("utf8") ?? ""} ${child.stderr?.toString("utf8") ?? ""}`,
        );
      }
      const parsed = parseOutput(stdout);
      if (parsed.HARNESS_ERROR !== undefined) {
        throw new Error(
          `native bridge harness failed: ${parsed.HARNESS_ERROR}`,
        );
      }
      return parsed;
    };

    const childStdout = (result: Readonly<Record<string, string>>): string =>
      Buffer.from(result.CHILD_STDOUT_B64 ?? "", "base64").toString("utf8");

    beforeAll(() => {
      const windir = process.env.WINDIR;
      if (windir === undefined) throw new Error("WINDIR is unavailable");
      const compiler = join(
        windir,
        "Microsoft.NET",
        "Framework64",
        "v4.0.30319",
        "csc.exe",
      );
      const harnessBytes = readFileSync(helperSource);
      const childBytes = readFileSync(childSource);
      expect(sha256(harnessBytes)).toBe(
        expectedSourceDigests["WindowsSandboxBridgeHarness.cs"],
      );
      expect(sha256(childBytes)).toBe(
        expectedSourceDigests["WindowsSandboxChild.cs"],
      );
      buildDirectory = mkdtempSync(join(tmpdir(), "arbor-sandbox-t3a-"));
      bridgeExecutable = join(
        buildDirectory,
        "WindowsSandboxBridgeHarness.exe",
      );
      childExecutable = join(buildDirectory, "WindowsSandboxChild.exe");
      const common = [
        "/nologo",
        "/warnaserror",
        "/platform:x64",
        "/reference:System.dll",
        "/reference:System.Core.dll",
        "/reference:System.Security.dll",
      ];
      execFileSync(
        compiler,
        [...common, "/target:exe", `/out:${childExecutable}`, childSource],
        { windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 },
      );
      execFileSync(
        compiler,
        [...common, "/target:exe", `/out:${bridgeExecutable}`, helperSource],
        { windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 },
      );
    });

    afterAll(() => {
      if (buildDirectory.length > 0) {
        rmSync(buildDirectory, { recursive: true, force: true });
      }
    });

    it("runs a same-user low-integrity AppContainer with explicit handles and projected environment", () => {
      const result = run("identity");
      const output = childStdout(result);
      expect(output).toContain("APPCONTAINER=1");
      expect(output).toMatch(/ENABLED_PRIVILEGE_COUNT=[01]/u);
      expect(output).toContain("LOW_INTEGRITY=1");
      expect(output).toContain("IN_JOB=1");
      expect(output).toContain(`USER_SID=${result.PARENT_USER_SID}`);
      expect(output).toContain("PATH_PRESENT=1");
      expect(output).toContain("SYSTEMROOT_PRESENT=1");
      expect(output).toContain("LOCALAPPDATA_PRESENT=1");
      expect(output).toContain(
        "ENVIRONMENT_NAMES=LOCALAPPDATA,PATH,SystemRoot,TEMP,TMP",
      );
      expect(output).toContain("SENTINEL_PRESENT=0");
      expect(output).toContain("STDIN_INVALID=1");
      expect(output).toContain("STDOUT_PRESENT=1");
      expect(output).toContain("STDERR_PRESENT=1");
      expect(result.HANDLE_LIST_COUNT).toBe("2");
      expect(result.ROOT_EXIT_CODE).toBe("0");
      expect(result.PROFILE_CREATED).toBe("1");
    });

    it("contains descendants in the Job Object, enforces process count and kills the tree on close", () => {
      const result = run("tree", { processCount: 2 });
      const output = childStdout(result);
      expect(output).toMatch(/DESCENDANT_PID=[1-9][0-9]*/u);
      expect(output).toContain("THIRD_CREATED=0");
      expect(output).toContain("THIRD_ERROR=1816");
      expect(result.JOB_KILL_ON_CLOSE).toBe("1");
      expect(result.JOB_LIMIT_FLAGS).toBe("8972");
      expect(result.JOB_PROCESS_LIMIT).toBe("2");
      expect(result.STOP_CLOSED_JOB).toBe("1");
      expect(result.ROOT_TERMINATED).toBe("1");
      expect(result.DESCENDANT_TERMINATED).toBe("1");
    });

    it("enforces walltime and output bounds", () => {
      const walltime = run("sleep", { walltimeMs: 300 });
      expect(walltime.WALLTIME_EXPIRED).toBe("1");
      expect(walltime.ROOT_TERMINATED).toBe("1");

      const output = run("flood", { stdoutBytes: 1024 });
      expect(output.OUTPUT_LIMIT_EXCEEDED).toBe("1");
      expect(
        Buffer.from(output.CHILD_STDOUT_B64 ?? "", "base64").byteLength,
      ).toBeLessThanOrEqual(1024);
    });

    it("records Job Object memory contrast and CPU quota termination", () => {
      const memory = run("memory", { memoryBytes: 64 * 1024 * 1024 });
      expect(childStdout(memory)).toContain("ALLOCATING=1");
      expect(childStdout(memory)).toContain("CHILD_ERROR=OutOfMemoryException");
      expect(memory.JOB_LIMIT_FLAGS).toBe("8972");
      expect(memory.JOB_PROCESS_MEMORY_LIMIT).toBe(String(64 * 1024 * 1024));
      expect(memory.JOB_MEMORY_LIMIT).toBe(String(64 * 1024 * 1024));
      expect(memory.ROOT_EXIT_CODE).toBe("24");

      const memoryControl = run("memory", {
        memoryBytes: 256 * 1024 * 1024,
      });
      expect(childStdout(memoryControl)).toContain("ALLOCATED=1");
      expect(memoryControl.JOB_PROCESS_MEMORY_LIMIT).toBe(
        String(256 * 1024 * 1024),
      );
      expect(memoryControl.JOB_MEMORY_LIMIT).toBe(String(256 * 1024 * 1024));
      expect(memoryControl.ROOT_EXIT_CODE).toBe("0");

      const cpu = run("cpu", { walltimeMs: 10000 });
      expect(childStdout(cpu)).toContain("BURNING_CPU=1");
      expect(cpu.JOB_CPU_TIME_MS).toBe("500");
      expect(cpu.JOB_CPU_RATE_FLAGS).toBe("5");
      expect(cpu.JOB_CPU_RATE).toBe("2000");
      expect(cpu.JOB_ACCOUNTING_AVAILABLE).toBe("1");
      expect(cpu.ROOT_EXIT_CODE_HEX).toBe("C0000044");
      expect(cpu.JOB_TOTAL_TERMINATED_PROCESSES).toBe("1");
      expect(Number(cpu.JOB_TOTAL_USER_TIME_MS)).toBeGreaterThanOrEqual(500);
      expect(cpu.WALLTIME_EXPIRED).toBe("0");
    });
  },
);
