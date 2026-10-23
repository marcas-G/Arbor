import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const source = join(
  testDirectory,
  "native",
  "WindowsSandboxLpacOptOutProbe.cs",
);

const parseOutput = (value: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    value
      .split(/\r?\n/u)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator > 0
          ? ([line.slice(0, separator), line.slice(separator + 1)] as const)
          : undefined;
      })
      .filter((entry) => entry !== undefined),
  );

const removeTemporaryDirectory = (path: string): void => {
  if (path.length === 0) return;
  const absolute = resolve(path);
  if (
    dirname(absolute) !== resolve(tmpdir()) ||
    !basename(absolute).startsWith("arbor-lpac-probe-")
  )
    throw new Error("refusing to remove a non-probe directory");
  rmSync(absolute, { recursive: true, force: true });
};

describe.skipIf(
  process.platform !== "win32" ||
    process.env.ARBOR_RUN_WINDOWS_LPAC_PROBE !== "1",
  "Windows LPAC all-packages opt-out microprobe (exploratory only)",
  () => {
    let fixtureRoot = "";
    let executable = "";

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
      readFileSync(source);
      fixtureRoot = mkdtempSync(join(tmpdir(), "arbor-lpac-probe-"));
      executable = join(fixtureRoot, "WindowsSandboxLpacOptOutProbe.exe");
      execFileSync(
        compiler,
        [
          "/nologo",
          "/warnaserror",
          "/platform:x64",
          "/reference:System.dll",
          "/reference:System.Core.dll",
          "/reference:System.Security.dll",
          "/target:exe",
          `/out:${executable}`,
          source,
        ],
        { windowsHide: true, timeout: 10_000 },
      );
    }, 10_000);

    afterAll(() => removeTemporaryDirectory(fixtureRoot));

    it("contrasts the existing regular AppContainer with the LPAC opt-out attribute for outside-ACL denial and exact mount/Temp writes", () => {
      const run = spawnSync(executable, [], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        env: process.env,
      });
      if (run.error !== undefined) throw run.error;
      const fields = parseOutput(run.stdout ?? "");
      if (fields.DRIVER_ERROR !== undefined)
        throw new Error(
          `LPAC probe driver failed: ${Buffer.from(fields.DRIVER_ERROR, "base64").toString("utf8")}`,
        );
      console.log(`LPAC_PROBE_FIELDS=${JSON.stringify(fields)}`);

      for (const label of ["REGULAR", "LPAC"]) {
        expect(fields[`${label}_CHILD_CREATED`]).toBe("1");
        expect(fields[`${label}_JOB_ASSIGNED`]).toBe("1");
        expect(fields[`${label}_PROCESS_STARTED`]).toBe("1");
        expect(fields[`${label}_CHILD_EXITED`]).toBe("1");
        expect(fields[`${label}_CHILD_EXIT_CODE`]).toBe("0");
        expect(fields[`${label}_WORKSPACE_OPS`]).toBe("PASS");
        expect(fields[`${label}_TEMP_OPS`]).toBe("PASS");
        expect(fields[`${label}_PROFILE_DELETED`]).toBe("1");
        expect(fields[`${label}_ACL_RESTORED`]).toBe("1");
      }
      expect(fields.REGULAR_OUTSIDE_READ).toBe("ALLOWED");
      expect(fields.REGULAR_OUTSIDE_CONTENT_MATCH).toBe("1");
      expect(fields.LPAC_OPT_OUT_ATTRIBUTE_ACCEPTED).toBe("1");
      expect(fields.LPAC_OUTSIDE_READ).toBe("DENIED");
      expect(fields.LPAC_OUTSIDE_CONTENT_MATCH).toBe("0");
      expect(fields.CLEANUP_FAILURES).toBe("0");
      expect(run.status).toBe(0);
    }, 15_000);
  },
);
