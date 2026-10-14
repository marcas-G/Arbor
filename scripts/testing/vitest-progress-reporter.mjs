import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { inspect } from "node:util";

const redactText = (value) =>
  String(value)
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, "$1-[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[REDACTED]",
    );

const sensitiveKey =
  /secret|token|authorization|password|api.?key|credential|cookie/i;

const sanitizeValue = (value, seen = new WeakSet(), key = "") => {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => sanitizeValue(item, seen));
  const output = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    try {
      output[name] = sanitizeValue(value[name], seen, name);
    } catch {
      output[name] = "[Uninspectable]";
    }
  }
  return output;
};

export const serializeErrorForReport = (error) => {
  const safe = sanitizeValue(error);
  const ownProperties =
    error !== null && (typeof error === "object" || typeof error === "function")
      ? Object.fromEntries(
          Object.getOwnPropertyNames(error).map((key) => {
            try {
              return [key, sanitizeValue(error[key], new WeakSet(), key)];
            } catch {
              return [key, "[Uninspectable]"];
            }
          }),
        )
      : {};
  const name =
    error !== null && (typeof error === "object" || typeof error === "function")
      ? sanitizeValue(error.name, new WeakSet(), "name")
      : null;
  const message =
    error !== null && (typeof error === "object" || typeof error === "function")
      ? sanitizeValue(error.message, new WeakSet(), "message")
      : null;
  const stack =
    error !== null && (typeof error === "object" || typeof error === "function")
      ? sanitizeValue(error.stack, new WeakSet(), "stack")
      : null;
  let stringValue;
  try {
    stringValue = redactText(String(error));
  } catch {
    stringValue = "[String conversion failed]";
  }
  let inspected;
  try {
    inspected = redactText(
      inspect(safe, { depth: 6, colors: false, getters: false }),
    );
  } catch {
    inspected = "[Inspection failed]";
  }
  const type =
    error !== null && (typeof error === "object" || typeof error === "function")
      ? redactText(error.constructor?.name ?? typeof error)
      : typeof error;
  return {
    name: typeof name === "string" ? name : null,
    type,
    message: typeof message === "string" ? message : null,
    stack: typeof stack === "string" ? stack : null,
    ownProperties,
    inspect: inspected,
    string: stringValue,
  };
};

const atomicWrite = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, contents, "utf8");
  const descriptor = openSync(temporaryPath, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
};

const elapsed = (start, end) => Math.max(0, end - start);

export const normalizeVitestJsonReport = (report, progress) => {
  if (!report || !Array.isArray(report.testResults) || !progress) return report;
  const normalizePath = (path) => String(path).replaceAll("\\", "/");
  const casesByKey = new Map(
    (progress.cases ?? []).map((testCase) => [
      `${normalizePath(testCase.file)}\u0000${testCase.fullName}`,
      testCase,
    ]),
  );
  for (const file of report.testResults) {
    for (const assertion of file.assertionResults ?? []) {
      const testCase = casesByKey.get(
        `${normalizePath(file.name)}\u0000${assertion.fullName}`,
      );
      const errors = testCase?.errors ?? [];
      const failures = Array.isArray(assertion.failureMessages)
        ? assertion.failureMessages
        : [];
      assertion.failureMessages = failures.map((failure, index) => {
        if (typeof failure === "string") return redactText(failure);
        const details = errors[index] ?? errors[0];
        return details
          ? `Unserializable test error: ${JSON.stringify(details)}`
          : "Vitest reported a failure without serializable error details.";
      });
      if (
        assertion.status === "failed" &&
        assertion.failureMessages.length === 0
      ) {
        assertion.failureMessages.push(
          errors.length > 0
            ? `Vitest test failed: ${JSON.stringify(errors[0])}`
            : "Vitest reported a failed test without serializable error details.",
        );
      }
    }
    if (typeof file.message === "string")
      file.message = redactText(file.message);
  }
  return report;
};

export default class VitestProgressReporter {
  constructor(options = {}) {
    this.options = options;
    this.resultDirectory =
      options.outputDirectory ?? process.env.ARBOR_TEST_RESULT_DIRECTORY;
    this.profile = options.profile ?? process.env.ARBOR_TEST_PROFILE ?? null;
    this.basename =
      options.basename ??
      process.env.ARBOR_VITEST_PROGRESS_BASENAME ??
      "vitest-progress";
    this.startedAt = Date.now();
    this.startedAtIso = new Date(this.startedAt).toISOString();
    this.updatedAt = this.startedAtIso;
    this.status = "running";
    this.current = null;
    this.cases = [];
    this.files = new Map();
    this.caseStartedAt = new Map();
    this.fileStartedAt = new Map();
    this.unhandledErrors = [];
  }

  onInit() {
    this.persist("runner-started");
    this.startHeartbeat();
  }

  onTestRunStart() {
    this.startedAt = Date.now();
    this.startedAtIso = new Date(this.startedAt).toISOString();
    this.persist("tests-started");
    this.startHeartbeat();
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.persist("heartbeat"), 30_000);
    this.heartbeatTimer.unref?.();
  }

  onTestModuleStart(module) {
    const file = module.moduleId;
    const relativeFile = module.relativeModuleId ?? module.moduleId;
    const now = Date.now();
    this.fileStartedAt.set(file, now);
    const prior = this.files.get(file) ?? {
      file,
      relativeFile,
      status: "queued",
      caseCount: 0,
    };
    this.files.set(file, {
      ...prior,
      relativeFile,
      status: "running",
      startedAt: new Date(now).toISOString(),
      finishedAt: null,
      durationMs: null,
    });
    this.current = {
      file,
      case: null,
      status: "file-running",
      startedAt: new Date(now).toISOString(),
    };
    this.persist("file-started");
  }

  onTestModuleEnd(module) {
    const file = module.moduleId;
    const now = Date.now();
    const started = this.fileStartedAt.get(file) ?? now;
    const prior = this.files.get(file) ?? { file, caseCount: 0 };
    this.files.set(file, {
      ...prior,
      status: module.ok() ? "passed" : "failed",
      finishedAt: new Date(now).toISOString(),
      durationMs: elapsed(started, now),
    });
    if (this.current?.file === file) this.current = null;
    this.persist("file-finished");
  }

  onTestCaseReady(testCase) {
    const now = Date.now();
    this.caseStartedAt.set(testCase.id, now);
    const file = testCase.module.moduleId;
    const relativeFile = testCase.module.relativeModuleId ?? file;
    const suite = this.files.get(file) ?? {
      file,
      relativeFile,
      status: "running",
      caseCount: 0,
    };
    suite.caseCount += 1;
    this.files.set(file, suite);
    this.current = {
      file,
      case: testCase.fullName,
      status: "running",
      startedAt: new Date(now).toISOString(),
    };
    const existing = this.cases.find((item) => item.id === testCase.id);
    const entry = {
      ...(existing ?? {}),
      id: testCase.id,
      file,
      relativeFile,
      case: testCase.name,
      fullName: testCase.fullName,
      status: "running",
      startedAt: new Date(now).toISOString(),
      finishedAt: null,
      durationMs: null,
      errors: [],
    };
    if (existing) Object.assign(existing, entry);
    else this.cases.push(entry);
    this.persist("test-started");
  }

  onTestCaseResult(testCase) {
    const now = Date.now();
    const started = this.caseStartedAt.get(testCase.id) ?? now;
    const file = testCase.module.moduleId;
    const relativeFile = testCase.module.relativeModuleId ?? file;
    const result = testCase.result();
    const status =
      result.state === "passed"
        ? "passed"
        : result.state === "failed"
          ? "failed"
          : "skipped";
    const errors = (result.errors ?? []).map(serializeErrorForReport);
    const existing = this.cases.find((item) => item.id === testCase.id);
    const entry = {
      ...(existing ?? {}),
      id: testCase.id,
      file,
      relativeFile,
      case: testCase.name,
      fullName: testCase.fullName,
      status,
      startedAt: existing?.startedAt ?? new Date(started).toISOString(),
      finishedAt: new Date(now).toISOString(),
      durationMs: elapsed(started, now),
      elapsedMs: elapsed(this.startedAt, now),
      errors,
    };
    if (existing) Object.assign(existing, entry);
    else this.cases.push(entry);
    this.current = null;
    this.persist("test-finished");
  }

  onTestRunEnd(_modules, unhandledErrors, reason) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unhandledErrors = (unhandledErrors ?? []).map(serializeErrorForReport);
    this.status = reason === "passed" ? "passed" : reason;
    this.current = null;
    this.persist("tests-finished");
  }

  persist(event) {
    if (!this.resultDirectory) return;
    const now = Date.now();
    this.updatedAt = new Date(now).toISOString();
    const counts = { passed: 0, failed: 0, skipped: 0, running: 0 };
    for (const testCase of this.cases) counts[testCase.status] += 1;
    const payload = {
      schemaVersion: 1,
      profile: this.profile,
      status: this.status,
      event,
      startedAt: this.startedAtIso,
      updatedAt: this.updatedAt,
      elapsedMs: elapsed(this.startedAt, now),
      current: this.current
        ? {
            ...this.current,
            elapsedMs: elapsed(Date.parse(this.current.startedAt), now),
          }
        : null,
      counts,
      files: [...this.files.values()].map((file) => ({
        ...file,
        elapsedMs: file.finishedAt
          ? file.durationMs
          : elapsed(Date.parse(file.startedAt ?? now), now),
      })),
      cases: this.cases.map((testCase) => ({
        ...testCase,
        elapsedMs: testCase.finishedAt
          ? testCase.durationMs
          : elapsed(Date.parse(testCase.startedAt ?? now), now),
      })),
      unhandledErrors: this.unhandledErrors,
    };
    const jsonPath = resolve(
      this.resultDirectory,
      this.options.jsonName ?? `${this.basename}-progress.json`,
    );
    const markdownPath = resolve(
      this.resultDirectory,
      this.options.markdownName ?? `${this.basename}-progress.md`,
    );
    atomicWrite(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    atomicWrite(markdownPath, this.renderMarkdown(payload));
  }

  renderMarkdown(payload) {
    const current = payload.current
      ? `${payload.current.file}${payload.current.case ? ` — ${payload.current.case}` : ""} (${payload.current.status})`
      : "none";
    const lines = [
      "# Vitest progress",
      "",
      `- Profile: ${payload.profile ?? "unspecified"}`,
      `- Status: ${payload.status}`,
      `- Elapsed: ${payload.elapsedMs} ms`,
      `- Last heartbeat: ${payload.updatedAt}`,
      `- Current: ${current}`,
      `- Tests: ${payload.counts.passed} passed, ${payload.counts.failed} failed, ${payload.counts.skipped} skipped, ${payload.counts.running} running`,
      "",
      "| File | Status | Started | Finished | Duration (ms) | Cases |",
      "|---|---|---|---|---:|---:|",
      ...payload.files.map(
        (file) =>
          `| ${file.relativeFile ?? file.file} | ${file.status} | ${file.startedAt ?? "—"} | ${file.finishedAt ?? "—"} | ${file.durationMs ?? "—"} | ${file.caseCount ?? 0} |`,
      ),
      "",
      "| Test | Status | Started | Finished | Duration (ms) |",
      "|---|---|---|---|---:|",
      ...payload.cases.map(
        (testCase) =>
          `| ${testCase.fullName} (${testCase.relativeFile ?? testCase.file}) | ${testCase.status} | ${testCase.startedAt ?? "—"} | ${testCase.finishedAt ?? "—"} | ${testCase.durationMs ?? "—"} |`,
      ),
      "",
    ];
    return `${lines.join("\n")}\n`;
  }
}
