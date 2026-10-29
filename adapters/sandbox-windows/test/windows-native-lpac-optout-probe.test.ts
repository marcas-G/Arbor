import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
} from "../../../tests/support/p39-windows-deployment-test.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const source = join(
  testDirectory,
  "native",
  "WindowsSandboxLpacOptOutProbe.cs",
);
const safeProbeFields = [
  "FIXTURE_ALL_APPS_ACE",
  "REGULAR_PROFILE_LOCAL_FIXTURE",
  "REGULAR_CHILD_CREATED",
  "REGULAR_JOB_ASSIGNED",
  "REGULAR_PROCESS_STARTED",
  "REGULAR_CHILD_EXITED",
  "REGULAR_CHILD_EXIT_CODE",
  "REGULAR_PROFILE_DELETED",
  "REGULAR_ACL_RESTORED",
  "REGULAR_OUTSIDE_READ",
  "REGULAR_OUTSIDE_CONTENT_MATCH",
  "REGULAR_WORKSPACE_OPS",
  "REGULAR_WORKSPACE_CONTENT_MATCH",
  "REGULAR_WORKSPACE_FIRST_EXISTS",
  "REGULAR_WORKSPACE_SECOND_EXISTS",
  "REGULAR_TEMP_OPS",
  "REGULAR_TEMP_CONTENT_MATCH",
  "REGULAR_TEMP_ENV_STATUS",
  "LPAC_PROFILE_LOCAL_FIXTURE",
  "LPAC_OPT_OUT_ATTRIBUTE_ACCEPTED",
  "LPAC_CHILD_CREATED",
  "LPAC_JOB_ASSIGNED",
  "LPAC_PROCESS_STARTED",
  "LPAC_CHILD_EXITED",
  "LPAC_CHILD_EXIT_CODE",
  "LPAC_PROFILE_DELETED",
  "LPAC_ACL_RESTORED",
  "LPAC_OUTSIDE_READ",
  "LPAC_OUTSIDE_CONTENT_MATCH",
  "LPAC_WORKSPACE_OPS",
  "LPAC_WORKSPACE_CONTENT_MATCH",
  "LPAC_WORKSPACE_FIRST_EXISTS",
  "LPAC_WORKSPACE_SECOND_EXISTS",
  "LPAC_TEMP_OPS",
  "LPAC_TEMP_CONTENT_MATCH",
  "LPAC_TEMP_ENV_STATUS",
  "CLEANUP_FAILURES",
] as const;

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
)("Windows LPAC all-packages opt-out microprobe (exploratory only)", () => {
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
    const artifactId = randomUUID();
    const resultDirectory = makeP39PrivateTestDirectory(
      join(process.cwd(), ".test-results"),
      "lpac-p39-raw-",
      true,
    );
    const artifactPath = join(resultDirectory, "probe-result.json");
    createP39PrivateTestFile(artifactPath, true);
    const startedAtUtc = new Date().toISOString();
    const run = spawnSync(executable, [], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: process.env,
    });
    const fields = parseOutput(run.stdout ?? "");
    const rawFields = Object.fromEntries(
      safeProbeFields.flatMap((name) =>
        fields[name] === undefined ? [] : [[name, fields[name] as string]],
      ),
    );
    const resultArtifact = {
      schema: "Arbor.WindowsLpacOptOutProbeRawV1",
      artifactId,
      probe: "regular-appcontainer-vs-lpac-all-apps-opt-out",
      proposalSha256:
        "29690BC98885FE028ADFCA9779D289DB7D733C7A455318746587FCDE627C072A",
      host: {
        platform: process.platform,
        osRelease: release(),
        architecture: arch(),
      },
      startedAtUtc,
      limits: { outerChildTimeoutMs: 15_000, workerCount: 1, retries: 0 },
      driverSourceSha256: createHash("sha256")
        .update(readFileSync(source))
        .digest("hex"),
      process: {
        status: run.status,
        signal: run.signal,
        errorCode:
          typeof run.error === "object" &&
          run.error !== null &&
          "code" in run.error
            ? String(run.error.code)
            : null,
      },
      childFields: rawFields,
    };
    writeFileSync(
      artifactPath,
      `${JSON.stringify(resultArtifact, null, 2)}\n`,
      {
        encoding: "utf8",
      },
    );
    console.log(`LPAC_P39_ARTIFACT_ID=${artifactId}`);

    if (run.error !== undefined) throw run.error;
    if (fields.DRIVER_ERROR !== undefined)
      throw new Error(
        `LPAC probe driver failed: ${Buffer.from(fields.DRIVER_ERROR, "base64").toString("utf8")}`,
      );

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
});
