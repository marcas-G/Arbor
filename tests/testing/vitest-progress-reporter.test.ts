import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import VitestProgressReporter, {
  collectEnvironmentRedactionValues,
  normalizeVitestJsonReport,
  redactTextForOutput,
  serializeErrorForReport,
} from "../../scripts/testing/vitest-progress-reporter.mjs";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
              ancestorTitles: ["reporter"],
              title: "synthetic failure",
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
          ancestorTitles: ["reporter"],
          title: "synthetic failure",
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

  it("redacts short sensitive values without treating drive prefixes as secrets", () => {
    const values = collectEnvironmentRedactionValues({
      API_KEY: "ab",
      SERVICE_TOKEN: "test",
      HOMEDRIVE: "C:",
      APP_MODE: "prod",
      SESSION_VALUE: "A1bc",
      USERPROFILE: "C:\\Users\\ThinkPad",
    });
    const redacted = redactTextForOutput(
      "credential ab; word cab; drive C:; path C:\\Users\\ThinkPad; module synthetic.test.ts; session A1bc; mode prod; value test",
      values,
    );

    expect(values).toEqual(["test", "prod", "A1bc", "ab"]);
    expect(redacted).toContain("credential [REDACTED]");
    expect(redacted).toContain("word cab");
    expect(redacted).toContain("drive C:");
    expect(redacted).toContain("path C:\\Users\\ThinkPad");
    expect(redacted).toContain("module synthetic.test.ts");
    expect(redacted).toContain("session [REDACTED]");
    expect(redacted).toContain("mode [REDACTED]");
    expect(redacted).toContain("value [REDACTED]");

    const sensitiveDriveValue = collectEnvironmentRedactionValues({
      API_KEY: "C:",
    });
    expect(
      redactTextForOutput(
        "path C:\\Users\\ThinkPad; key C:",
        sensitiveDriveValue,
      ),
    ).toBe("path C:\\Users\\ThinkPad; key [REDACTED]");
  });

  describe("outer suite", () => {
    describe("repeated branch", () => {
      it("maps nested duplicate titles by ancestor array and occurrence", () => {
        const directory = temporaryDirectory();
        const reporter = new VitestProgressReporter({
          outputDirectory: directory,
          basename: "nested",
        });
        const secret = "Bearer very-secret-token-value";
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const module = {
          moduleId: "/workspace/tests/nested.test.ts",
          relativeModuleId: "tests/nested.test.ts",
          ok: () => false,
        };
        const moduleParent = { type: "module", name: "tests/nested.test.ts" };
        const outerSuite = {
          type: "suite",
          name: "outer suite",
          parent: moduleParent,
        };
        const nestedSuite = {
          type: "suite",
          name: "repeated branch",
          parent: outerSuite,
        };
        const makeCase = (id: string, code: string, message: string) => ({
          id,
          name: "same title",
          fullName: "outer suite > repeated branch > same title",
          parent: nestedSuite,
          module,
          result: () => ({
            state: "failed",
            errors: [{ code, message, customToken: secret }],
          }),
        });
        const first = makeCase("duplicate-1", "FIRST", secret);
        const second = makeCase("duplicate-2", "SECOND", "second failure");

        reporter.onInit();
        reporter.onTestRunStart();
        reporter.onTestModuleStart(module);
        reporter.onTestCaseReady(first);
        reporter.onTestCaseReady(second);
        reporter.onTestCaseResult(first);
        const afterFirstFinish = JSON.parse(
          readFileSync(join(directory, "nested-progress.json"), "utf8"),
        );
        expect(afterFirstFinish.activeCases).toHaveLength(1);
        expect(afterFirstFinish.activeCases[0].id).toBe(second.id);
        expect(afterFirstFinish.current.caseId).toBe(second.id);
        reporter.onTestCaseResult(second);
        reporter.onTestModuleEnd(module);
        reporter.onTestRunEnd([], [], "failed");

        const progress = JSON.parse(
          readFileSync(join(directory, "nested-progress.json"), "utf8"),
        ) as {
          cases: Array<{ occurrence: number; ancestorTitles: string[] }>;
        };
        const report = normalizeVitestJsonReport(
          {
            testResults: [
              {
                name: module.moduleId,
                message: "",
                assertionResults: [
                  {
                    ancestorTitles: ["outer suite", "repeated branch"],
                    title: "same title",
                    status: "failed",
                    failureMessages: [null],
                  },
                  {
                    ancestorTitles: ["outer suite", "repeated branch"],
                    title: "same title",
                    status: "failed",
                    failureMessages: [null],
                  },
                ],
              },
            ],
          },
          progress,
        );
        const failures = (report.testResults[0]?.assertionResults ?? []).map(
          (assertion) => assertion.failureMessages[0],
        );
        const allOutput = [
          JSON.stringify(progress),
          JSON.stringify(report),
          ...log.mock.calls.flat().map(String),
        ].join("\n");

        expect(progress.cases).toHaveLength(2);
        expect(progress.cases.map((testCase) => testCase.occurrence)).toEqual([
          0, 1,
        ]);
        expect(progress.cases[0]?.ancestorTitles).toEqual([
          "outer suite",
          "repeated branch",
        ]);
        expect(failures[0]).toContain('"code":"FIRST"');
        expect(failures[1]).toContain('"code":"SECOND"');
        expect(allOutput).not.toContain(secret);
        expect(allOutput).not.toContain("very-secret-token-value");
      });
    });
  });
});
