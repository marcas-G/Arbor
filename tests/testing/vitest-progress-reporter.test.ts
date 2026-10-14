import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import VitestProgressReporter, {
  normalizeVitestJsonReport,
  serializeErrorForReport,
} from "../../scripts/testing/vitest-progress-reporter.mjs";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "arbor-vitest-progress-"));
  directories.push(directory);
  return directory;
};

describe("Vitest progress reporter", () => {
  it("writes atomic per-case and per-file progress and preserves unusual errors", () => {
    const directory = temporaryDirectory();
    const reporter = new VitestProgressReporter({
      outputDirectory: directory,
      basename: "vitest",
    });
    const thrown = {
      code: "ERR_SYNTHETIC",
      authorization: "Bearer should-not-be-written",
      detail: "synthetic reporter failure",
    };
    const module = {
      moduleId: "/workspace/tests/synthetic.test.ts",
      relativeModuleId: "tests/synthetic.test.ts",
      ok: () => false,
    };
    const testCase = {
      id: "synthetic-case-id",
      name: "serializes an object without Error fields",
      fullName: "reporter > serializes an object without Error fields",
      module,
      result: () => ({ state: "failed", errors: [thrown] }),
    };

    reporter.onInit();
    reporter.onTestRunStart();
    reporter.onTestModuleStart(module);
    reporter.onTestCaseReady(testCase);
    reporter.onTestCaseResult(testCase);
    reporter.onTestModuleEnd(module);
    reporter.onTestRunEnd([], [], "failed");

    const progress = JSON.parse(
      readFileSync(join(directory, "vitest-progress.json"), "utf8"),
    ) as {
      status: string;
      counts: { failed: number; running: number };
      files: Array<{
        status: string;
        startedAt: string;
        finishedAt: string;
        durationMs: number;
      }>;
      cases: Array<{
        status: string;
        startedAt: string;
        finishedAt: string;
        durationMs: number;
        errors: Array<Record<string, unknown>>;
      }>;
    };
    expect(progress.status).toBe("failed");
    expect(progress.counts).toMatchObject({ failed: 1, running: 0 });
    expect(progress.files[0]).toMatchObject({ status: "failed" });
    expect(progress.files[0]?.startedAt).toBeTruthy();
    expect(progress.files[0]?.finishedAt).toBeTruthy();
    expect(progress.cases[0]).toMatchObject({ status: "failed" });
    expect(progress.cases[0]?.startedAt).toBeTruthy();
    expect(progress.cases[0]?.finishedAt).toBeTruthy();
    expect(progress.cases[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(progress.cases[0]?.errors[0]).toMatchObject({
      type: "Object",
      message: null,
      stack: null,
    });
    expect(JSON.stringify(progress)).not.toContain("should-not-be-written");
    expect(
      readFileSync(join(directory, "vitest-progress.md"), "utf8"),
    ).toContain("tests/synthetic.test.ts");
    expect(readdirSync(directory).sort()).toEqual([
      "vitest-progress.json",
      "vitest-progress.md",
    ]);
  });

  it("normalizes null Vitest failureMessages from the per-case error evidence", () => {
    const error = serializeErrorForReport({
      code: "ERR_SYNTHETIC",
      detail: "failure",
    });
    const report = {
      testResults: [
        {
          name: "/workspace/tests/synthetic.test.ts",
          message: "",
          assertionResults: [
            {
              fullName: "reporter > synthetic failure",
              status: "failed",
              failureMessages: [null],
            },
          ],
        },
      ],
    };
    const normalized = normalizeVitestJsonReport(report, {
      cases: [
        {
          file: "/workspace/tests/synthetic.test.ts",
          fullName: "reporter > synthetic failure",
          errors: [error],
        },
      ],
    });
    const failureMessages =
      normalized.testResults[0]?.assertionResults[0]?.failureMessages;
    expect(failureMessages).toHaveLength(1);
    expect(failureMessages?.[0]).toContain('"type":"Object"');
    expect(failureMessages?.some((message) => message === null)).toBe(false);
  });
});
