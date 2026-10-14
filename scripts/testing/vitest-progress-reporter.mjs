import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { inspect } from "node:util";

const sensitiveEnvironmentName =
  /secret|token|authorization|password|api.?key|credential|cookie/i;

export const collectEnvironmentRedactionValues = (environment) =>
  Object.entries(environment)
    .filter(([key, value]) => {
      if (typeof value !== "string" || value.length === 0) return false;
      if (sensitiveEnvironmentName.test(key)) return true;
      if (/^[A-Za-z]:$/.test(value)) return false;
      return value.length >= 4 && !/[\\/:\s]/.test(value);
    })
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);

const sensitiveEnvironmentValues = collectEnvironmentRedactionValues(
  process.env,
);

const redactEnvironmentValues = (value, secrets) => {
  let redacted = String(value);
  for (const secret of secrets) {
    let cursor = 0;
    let output = "";
    while (cursor < redacted.length) {
      const index = redacted.indexOf(secret, cursor);
      if (index < 0) {
        output += redacted.slice(cursor);
        break;
      }
      const before = index > 0 ? redacted[index - 1] : "";
      const after = redacted[index + secret.length] ?? "";
      const isIdentifier = (character) =>
        /[A-Za-z0-9._-]/.test(character) ||
        character === "/" ||
        character === "\\";
      if (
        (!before || !isIdentifier(before)) &&
        (!after || !isIdentifier(after))
      ) {
        output += `${redacted.slice(cursor, index)}[REDACTED]`;
        cursor = index + secret.length;
      } else {
        output += redacted.slice(cursor, index + 1);
        cursor = index + 1;
      }
    }
    redacted = output;
  }
  return redacted;
};

const redactText = (value) => {
  const redacted = String(value)
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, "$1-[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[REDACTED]",
    );
  return redactEnvironmentValues(redacted, sensitiveEnvironmentValues);
};

export const redactTextForOutput = (value, environmentOrValues = process.env) =>
  redactEnvironmentValues(
    redactText(value),
    Array.isArray(environmentOrValues)
      ? environmentOrValues
      : collectEnvironmentRedactionValues(environmentOrValues),
  );

const normalizedPath = (path) => String(path).replaceAll("\\", "/");

const testCaseKey = (file, ancestorTitles, title) =>
  JSON.stringify([normalizedPath(file), ancestorTitles, title]);

const ancestorTitlesOf = (testCase) => {
  const titles = [];
  let parent = testCase.parent;
  while (parent && parent.type !== "module") {
    titles.unshift(parent.name);
    parent = parent.parent;
  }
  return titles;
};

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

let atomicWriteSequence = 0;

const atomicWrite = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${atomicWriteSequence++}`;
  writeFileSync(temporaryPath, contents, "utf8");
  const descriptor = openSync(temporaryPath, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporaryPath, path);
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (!["EPERM", "EACCES", "EBUSY"].includes(code) || attempt >= 7) {
        rmSync(temporaryPath, { force: true });
        throw error;
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        10 * (attempt + 1),
      );
    }
  }
};

const elapsed = (start, end) => Math.max(0, end - start);

export const normalizeVitestJsonReport = (report, progress) => {
  if (!report || !Array.isArray(report.testResults) || !progress) return report;
  const casesByKey = new Map();
  for (const testCase of progress.cases ?? []) {
    const key = testCaseKey(
      testCase.file,
      testCase.ancestorTitles ?? [],
      testCase.title ?? testCase.case,
    );
    const matches = casesByKey.get(key) ?? [];
    matches.push(testCase);
    casesByKey.set(key, matches);
  }
  for (const matches of casesByKey.values()) {
    matches.sort((left, right) => left.occurrence - right.occurrence);
  }
  const caseCursors = new Map();
  for (const file of report.testResults) {
    for (const assertion of file.assertionResults ?? []) {
      const key = testCaseKey(
        file.name,
        assertion.ancestorTitles ?? [],
        assertion.title,
      );
      const matches = casesByKey.get(key) ?? [];
      const occurrence = caseCursors.get(key) ?? 0;
      const testCase = matches[occurrence];
      caseCursors.set(key, occurrence + 1);
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
    this.caseById = new Map();
    this.activeCases = new Map();
    this.activeFiles = new Map();
    this.caseOccurrences = new Map();
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
    this.heartbeatTimer = setInterval(() => {
      this.persist("heartbeat");
      this.logHeartbeat();
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  logHeartbeat() {
    const active = [...this.activeCases.values()]
      .slice(-5)
      .map((testCase) => redactText(testCase.fullName));
    const remainder = Math.max(0, this.activeCases.size - active.length);
    console.log(
      `[vitest-progress] heartbeat elapsed=${elapsed(this.startedAt, Date.now())}ms active=${JSON.stringify(active)}${remainder ? ` +${remainder} more` : ""}`,
    );
  }

  setCurrentFromActiveCases() {
    const latestActive = [...this.activeCases.values()].at(-1);
    if (latestActive) {
      this.current = {
        file: latestActive.file,
        case: latestActive.fullName,
        caseId: latestActive.id,
        status: "running",
        startedAt: latestActive.startedAt,
      };
      return;
    }
    const latestFile = [...this.activeFiles.values()].at(-1);
    this.current = latestFile
      ? {
          file: latestFile.file,
          case: null,
          status: "file-running",
          startedAt: latestFile.startedAt,
        }
      : null;
  }

  onTestModuleStart(module) {
    const file = module.moduleId;
    const relativeFile = module.relativeModuleId ?? module.moduleId;
    const now = Date.now();
    this.fileStartedAt.set(file, now);
    this.activeFiles.set(file, {
      file,
      startedAt: new Date(now).toISOString(),
    });
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
    this.setCurrentFromActiveCases();
    this.persist("file-started");
    console.log(`[vitest-progress] FILE START ${redactText(relativeFile)}`);
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
    this.activeFiles.delete(file);
    this.setCurrentFromActiveCases();
    this.persist("file-finished");
    console.log(
      `[vitest-progress] FILE ${module.ok() ? "PASS" : "FAIL"} ${redactText(this.files.get(file)?.relativeFile ?? file)} (${elapsed(started, now)}ms)`,
    );
  }

  onTestCaseReady(testCase) {
    const now = Date.now();
    this.caseStartedAt.set(testCase.id, now);
    const file = testCase.module.moduleId;
    const relativeFile = testCase.module.relativeModuleId ?? file;
    const ancestorTitles = ancestorTitlesOf(testCase);
    const occurrenceKey = testCaseKey(file, ancestorTitles, testCase.name);
    const existing = this.caseById.get(testCase.id);
    const occurrence =
      existing?.occurrence ?? this.caseOccurrences.get(occurrenceKey) ?? 0;
    if (!existing) this.caseOccurrences.set(occurrenceKey, occurrence + 1);
    const suite = this.files.get(file) ?? {
      file,
      relativeFile,
      status: "running",
      caseCount: 0,
    };
    suite.caseCount += 1;
    this.files.set(file, suite);
    const entry = {
      ...(existing ?? {}),
      id: testCase.id,
      file,
      relativeFile,
      case: testCase.name,
      title: testCase.name,
      ancestorTitles,
      occurrence,
      fullName: testCase.fullName,
      key: occurrenceKey,
      status: "running",
      startedAt: new Date(now).toISOString(),
      finishedAt: null,
      durationMs: null,
      errors: [],
    };
    if (existing) Object.assign(existing, entry);
    else {
      this.cases.push(entry);
      this.caseById.set(testCase.id, entry);
    }
    this.activeCases.set(testCase.id, entry);
    this.setCurrentFromActiveCases();
    this.persist("test-started");
    console.log(
      `[vitest-progress] START ${redactText(relativeFile)} :: ${redactText([...ancestorTitles, testCase.name].join(" > "))}`,
    );
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
    const existing = this.caseById.get(testCase.id);
    const entry = {
      ...(existing ?? {}),
      id: testCase.id,
      file,
      relativeFile,
      case: testCase.name,
      title: testCase.name,
      ancestorTitles: existing?.ancestorTitles ?? ancestorTitlesOf(testCase),
      occurrence: existing?.occurrence ?? 0,
      fullName: testCase.fullName,
      key:
        existing?.key ??
        testCaseKey(file, ancestorTitlesOf(testCase), testCase.name),
      status,
      startedAt: existing?.startedAt ?? new Date(started).toISOString(),
      finishedAt: new Date(now).toISOString(),
      durationMs: elapsed(started, now),
      elapsedMs: elapsed(this.startedAt, now),
      errors,
    };
    if (existing) Object.assign(existing, entry);
    else {
      this.cases.push(entry);
      this.caseById.set(testCase.id, entry);
    }
    this.activeCases.delete(testCase.id);
    this.setCurrentFromActiveCases();
    this.persist("test-finished");
    const title = [...entry.ancestorTitles, entry.title].join(" > ");
    const errorsText = errors
      .map(
        (serialized) =>
          serialized.message ??
          serialized.stack ??
          `${serialized.type}: ${serialized.inspect} (${serialized.string})`,
      )
      .filter(Boolean)
      .join(" | ");
    console.log(
      `[vitest-progress] ${status.toUpperCase()} ${redactText(relativeFile)} :: ${redactText(title)} (${entry.durationMs}ms)${errorsText ? ` — ${redactText(errorsText)}` : ""}`,
    );
  }

  onTestRunEnd(_modules, unhandledErrors, reason) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unhandledErrors = (unhandledErrors ?? []).map(serializeErrorForReport);
    this.status = reason === "passed" ? "passed" : reason;
    this.activeCases.clear();
    this.activeFiles.clear();
    this.setCurrentFromActiveCases();
    this.persist("tests-finished");
    for (const error of this.unhandledErrors) {
      console.log(
        `[vitest-progress] UNHANDLED ${redactText(error.message ?? error.stack ?? `${error.type}: ${error.inspect} (${error.string})`)}`,
      );
    }
  }

  persist(event) {
    if (!this.resultDirectory) return;
    const now = Date.now();
    this.updatedAt = new Date(now).toISOString();
    const counts = { passed: 0, failed: 0, skipped: 0, running: 0 };
    for (const testCase of this.cases) counts[testCase.status] += 1;
    const payload = sanitizeValue({
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
      activeCases: [...this.activeCases.values()].slice(-5).map((testCase) => ({
        id: testCase.id,
        file: testCase.relativeFile,
        case: testCase.fullName,
        startedAt: testCase.startedAt,
        elapsedMs: elapsed(Date.parse(testCase.startedAt), now),
      })),
      activeCasesOmitted: Math.max(0, this.activeCases.size - 5),
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
    });
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
