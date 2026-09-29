import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vitestCli = resolve(repoRoot, "node_modules/vitest/vitest.mjs");
const catalogPath = resolve(repoRoot, "tests/capability/case-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const mode = process.argv[2] ?? "gray-box";
if (mode !== "gray-box" && mode !== "real-provider") {
  throw new Error(
    "usage: run-capability.mjs <gray-box|real-provider> --capabilities=B01,B02",
  );
}
const selectionArg = process.argv
  .slice(3)
  .find((argument) => argument.startsWith("--capabilities="));
const selectedIds = new Set(
  (selectionArg?.slice("--capabilities=".length) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
if (selectedIds.size === 0) {
  throw new Error("--capabilities=B01,B02,... is required");
}
for (const id of selectedIds) {
  if (
    !catalog.capabilities.some((capability) => capability.capabilityId === id)
  ) {
    throw new Error(`unknown capability id ${id}`);
  }
}
const selectedCapabilities = catalog.capabilities.filter((capability) =>
  selectedIds.has(capability.capabilityId),
);

const startedAt = new Date();
const runId = `${startedAt.toISOString().replaceAll(":", "-")}-${randomUUID()}`;
const reportRoot = resolve(
  repoRoot,
  "planning/testing/core-capability/reports",
);
const reportPath = join(reportRoot, `capability-${mode}-${runId}.json`);
const markdownPath = join(reportRoot, `capability-${mode}-${runId}.md`);
const tempRoot = join(tmpdir(), `arbor-capability-${runId}`);
mkdirSync(tempRoot, {
  recursive: true,
});
const inventoryPath = resolve(
  repoRoot,
  "planning/testing/core-capability/suite-evidence-inventory.json",
);
const inventory = existsSync(inventoryPath)
  ? JSON.parse(readFileSync(inventoryPath, "utf8"))
  : undefined;

const normalize = (path) => path.split(sep).join("/");
const unique = (values) => [...new Set(values)];

const providerConfigFile = () => {
  const explicit = process.env.ARBOR_CAPABILITY_CONFIG?.trim();
  const path = explicit
    ? resolve(explicit)
    : resolve(repoRoot, "capability.config.json");
  if (!existsSync(path)) {
    return explicit ? { path, error: "not found" } : null;
  }
  try {
    return { path, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { path, error: `invalid JSON: ${String(error)}` };
  }
};

const providerFile = providerConfigFile();

/** Resolve provider settings from env first, then capability.config.json.
 * The resolved values are re-exported as env for the vitest child processes
 * (and the B12 daemon spawn), so file-based config stays transparent. */
const configuredProvider = () => {
  const missing = [];
  const file = providerFile?.value ?? {};
  const fromEnv = (key) => {
    const raw = process.env[key]?.trim();
    return raw ? raw : undefined;
  };
  const url = fromEnv("ARBOR_CAPABILITY_PROVIDER_URL") ?? file.providerUrl;
  const model = fromEnv("ARBOR_CAPABILITY_MODEL") ?? file.model;
  const serverBuildId =
    fromEnv("ARBOR_CAPABILITY_SERVER_BUILD_ID") ?? file.serverBuildId;
  const auth = fromEnv("ARBOR_CAPABILITY_AUTH") ?? file.auth ?? "none";
  if (!url) missing.push("providerUrl (ARBOR_CAPABILITY_PROVIDER_URL)");
  if (!model) missing.push("model (ARBOR_CAPABILITY_MODEL)");
  if (!serverBuildId) {
    missing.push("serverBuildId (ARBOR_CAPABILITY_SERVER_BUILD_ID)");
  }
  if (auth !== "none" && auth !== "env") {
    missing.push("auth must be none or env");
  }
  const apiKeyVar = file.apiKeyVar?.trim() || undefined;
  const apiKey =
    fromEnv("ARBOR_CAPABILITY_API_KEY") ??
    (apiKeyVar ? process.env[apiKeyVar] : undefined) ??
    file.apiKey;
  if (auth === "env" && !apiKey) {
    missing.push("apiKey (ARBOR_CAPABILITY_API_KEY / apiKeyVar / apiKey)");
  }
  return {
    ready: missing.length === 0,
    missing,
    file: providerFile,
    exportEnv: {
      ...(url ? { ARBOR_CAPABILITY_PROVIDER_URL: url } : {}),
      ...(model ? { ARBOR_CAPABILITY_MODEL: model } : {}),
      ...(serverBuildId
        ? { ARBOR_CAPABILITY_SERVER_BUILD_ID: serverBuildId }
        : {}),
      ARBOR_CAPABILITY_AUTH: auth,
      ...(auth === "env" && apiKey ? { ARBOR_CAPABILITY_API_KEY: apiKey } : {}),
    },
  };
};

const rootFiles = unique(
  selectedCapabilities.flatMap((capability) => [
    ...capability.l1Suites,
    ...capability.l2Suites,
  ]),
);
const webFiles = rootFiles
  .filter((path) => path.startsWith("apps/web/test/"))
  .map((path) => path.slice("apps/web/".length));
const coreFiles = rootFiles.filter((path) => !path.startsWith("apps/web/"));
const harnessFiles = ["tests/capability/harness.test.ts"];
const runNotes = [];

const invokeVitest = (input) => {
  const outputPath = join(tempRoot, `${input.label}.vitest.json`);
  const args = [
    vitestCli,
    "run",
    "--reporter=json",
    "--outputFile",
    outputPath,
    ...(input.config === undefined ? [] : ["--config", input.config]),
    ...(input.extraArgs ?? []),
    ...input.files,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: input.cwd ?? repoRoot,
    encoding: "utf8",
    env: input.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!existsSync(outputPath)) {
    return {
      exitCode: result.status ?? 1,
      report: undefined,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }
  return {
    exitCode: result.status ?? 1,
    report: JSON.parse(readFileSync(outputPath, "utf8")),
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

const runResults = [];
if (coreFiles.length > 0 || harnessFiles.length > 0) {
  runResults.push(
    invokeVitest({
      label: "root-gray-box",
      files: [...coreFiles, ...harnessFiles],
    }),
  );
}
if (webFiles.length > 0) {
  runResults.push(
    invokeVitest({
      label: "web-gray-box",
      cwd: resolve(repoRoot, "apps/web"),
      config: "vitest.config.ts",
      files: webFiles.map((path) => path.slice("test/".length)),
    }),
  );
}

let providerState = configuredProvider();
const realProviderRuns = new Map();
const evidenceDirectory = resolve(
  process.env.ARBOR_CAPABILITY_EVIDENCE_DIR?.trim() ||
    providerConfigFile()?.value?.evidenceDir?.trim() ||
    "planning/testing/core-capability/evidence/real-provider",
);
const existingEvidence = new Set(
  existsSync(evidenceDirectory)
    ? readdirSync(evidenceDirectory).filter((name) => name.endsWith(".json"))
    : [],
);

if (mode === "real-provider") {
  providerState = configuredProvider();
  const fileNote = providerState.file
    ? providerState.file.error !== undefined
      ? `provider config file ${providerState.file.path} ignored (${providerState.file.error})`
      : `provider config file in effect: ${providerState.file.path}`
    : "provider config file: none (env only)";
  runNotes.push(fileNote);
  if (!providerState.ready) {
    runNotes.push(
      `REAL provider cases were not launched; missing configuration: ${providerState.missing.join(", ")}`,
    );
  } else {
    const realConfig = resolve(repoRoot, "vitest.capability-real.config.ts");
    for (const capability of selectedCapabilities) {
      const testFile = capability.l3.testFile;
      if (
        testFile === null ||
        !testFile.startsWith("tests/capability/real-provider/")
      ) {
        continue;
      }
      const result = invokeVitest({
        label: `real-provider-${capability.capabilityId}`,
        config: realConfig,
        files: [testFile],
        extraArgs: [
          "--repeats",
          "3",
          "--testNamePattern",
          capability.l3.caseId,
        ],
        env: {
          ...process.env,
          ...providerState.exportEnv,
          ARBOR_CAPABILITY_RUN_ID: runId,
          ARBOR_CAPABILITY_EVIDENCE_DIR: evidenceDirectory,
        },
      });
      realProviderRuns.set(capability.capabilityId, result);
      runResults.push(result);
      if (result.exitCode !== 0) {
        runNotes.push(
          `${capability.capabilityId} real-provider behavioral sentinel failed or was unstable.`,
        );
      }
    }
  }
}

const fileResults = new Map();
for (const run of runResults) {
  for (const suite of run.report?.testResults ?? []) {
    fileResults.set(normalize(relative(repoRoot, suite.name)), suite);
  }
}

const assertionFailures = [];
for (const run of runResults) {
  for (const suite of run.report?.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === "failed") {
        assertionFailures.push({
          suiteFile: normalize(relative(repoRoot, suite.name)),
          testName: assertion.fullName ?? assertion.title ?? "unnamed test",
        });
      }
    }
  }
}

const resultForSuites = (suiteFiles) => {
  const missing = suiteFiles.filter(
    (path) => !existsSync(resolve(repoRoot, path)),
  );
  if (missing.length > 0) {
    return {
      status: "FAIL",
      reason: `Mapped source suite is missing: ${missing.join(", ")}`,
      failures: [],
    };
  }
  const results = suiteFiles.map((path) => fileResults.get(normalize(path)));
  const absent = suiteFiles.filter(
    (_path, index) => results[index] === undefined,
  );
  if (absent.length > 0) {
    return {
      status: "NOT_RUN",
      reason: `Vitest did not report mapped suite(s): ${absent.join(", ")}`,
      failures: [],
    };
  }
  const failedFiles = suiteFiles.filter(
    (_path, index) => results[index]?.status !== "passed",
  );
  if (failedFiles.length > 0) {
    return {
      status: "FAIL",
      reason: `One or more mapped suites failed: ${failedFiles.join(", ")}`,
      failures: assertionFailures.filter((failure) =>
        failedFiles.includes(failure.suiteFile),
      ),
    };
  }
  return {
    status: "PASS",
    reason: undefined,
    failures: [],
  };
};

const levelCases = [];
for (const capability of selectedCapabilities) {
  for (const evidenceLevel of ["L1", "L2"]) {
    const suiteFiles =
      evidenceLevel === "L1" ? capability.l1Suites : capability.l2Suites;
    const metadata = {
      caseId: `${capability.capabilityId}-${evidenceLevel}`,
      capabilityId: capability.capabilityId,
      evidenceLevel,
      providerMode:
        evidenceLevel === "L2"
          ? (capability.l2ProviderMode ??
            (capability.capabilityId === "B01" ||
            capability.capabilityId === "B04"
              ? "RECORDING"
              : "NONE"))
          : "NONE",
      requiresPersistence: evidenceLevel === "L2",
      requiresRestart:
        evidenceLevel === "L2" &&
        (capability.capabilityId === "B12" ||
          capability.capabilityId === "B13"),
      expectedStatus:
        evidenceLevel === "L2"
          ? (capability.l2ExpectedStatus ?? "PASS")
          : "PASS",
    };
    const sourceSuiteResult = resultForSuites(suiteFiles);
    const blocked =
      evidenceLevel === "L2" &&
      capability.l2ExpectedStatus?.startsWith("BLOCKED_BY_") === true;
    levelCases.push({
      ...metadata,
      status: blocked ? capability.l2ExpectedStatus : sourceSuiteResult.status,
      sourceSuiteStatus: sourceSuiteResult.status,
      sourceSuites: suiteFiles,
      reason: blocked ? capability.l2BlockingReason : sourceSuiteResult.reason,
      failures: sourceSuiteResult.failures,
    });
  }
}

const newEvidenceFiles = existsSync(evidenceDirectory)
  ? readdirSync(evidenceDirectory)
      .filter(
        (name) =>
          name.endsWith(".json") &&
          !existingEvidence.has(name) &&
          /-L3-REAL-/.test(name),
      )
      .map((name) =>
        normalize(relative(repoRoot, join(evidenceDirectory, name))),
      )
  : [];

const realCaseStatus = (caseDefinition) => {
  if (caseDefinition.expectedStatus.startsWith("BLOCKED_BY_")) {
    return {
      status: caseDefinition.expectedStatus,
      reason: caseDefinition.blockingReason,
    };
  }
  if (mode !== "real-provider") {
    return {
      status: "NOT_RUN",
      reason: "Real-provider cases run only with pnpm test:capability:real.",
    };
  }
  if (caseDefinition.testFile !== null && providerState.ready) {
    const owner = selectedCapabilities.find(
      (capability) => capability.capabilityId === caseDefinition.capabilityId,
    );
    const run =
      owner === undefined
        ? undefined
        : realProviderRuns.get(owner.capabilityId);
    if (run === undefined) {
      return {
        status: "NOT_RUN",
        reason:
          "This case was not selected in the current qualification batch.",
      };
    }
    const suiteFile = normalize(caseDefinition.testFile);
    const suite = run.report?.testResults?.find(
      (candidate) =>
        normalize(relative(repoRoot, candidate.name)) === suiteFile,
    );
    const assertions = (suite?.assertionResults ?? []).filter((assertion) =>
      (assertion.fullName ?? assertion.title ?? "").includes(
        caseDefinition.caseId,
      ),
    );
    // Vitest's JSON reporter collapses --repeats into a single assertion, so
    // the stability oracle counts the per-repetition evidence files (each
    // captured run writes its own PASS/FAIL record).
    const expectedRuns = 3;
    const evidenceFilesForCase = newEvidenceFiles.filter((path) =>
      path.includes(`/${caseDefinition.caseId}-`),
    );
    const evidenceStatuses = evidenceFilesForCase.map((path) => {
      try {
        return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")).status;
      } catch {
        return "UNREADABLE";
      }
    });
    const passRuns = evidenceStatuses.filter(
      (status) => status === "PASS",
    ).length;
    const failRuns = evidenceStatuses.filter(
      (status) => status === "FAIL",
    ).length;
    const reported = evidenceStatuses.length;
    const status =
      passRuns >= expectedRuns && failRuns === 0
        ? "PASS"
        : failRuns > 0 || passRuns > 0
          ? "FAIL"
          : "NOT_RUN";
    return {
      status,
      reason:
        status === "PASS"
          ? undefined
          : status === "FAIL"
            ? `Real-provider stability oracle: ${passRuns}/${expectedRuns} PASS, ${failRuns}/${expectedRuns} FAIL (evidence-counted).`
            : `No captured three-run evidence for ${caseDefinition.caseId}.`,
      repetitions: {
        expected: expectedRuns,
        passed: passRuns,
        failed: failRuns,
        reported,
      },
      evidenceFiles: evidenceFilesForCase,
      assertionFailures: assertions
        .filter((assertion) => assertion.status === "failed")
        .map((assertion) => ({
          testName: assertion.fullName ?? assertion.title,
          failureMessages: assertion.failureMessages,
        })),
    };
  }
  if (caseDefinition.testFile !== null && !providerState.ready) {
    return {
      status: "NOT_RUN",
      reason: `Real provider configuration missing: ${providerState.missing.join(", ")}`,
    };
  }
  if (caseDefinition.expectedStatus === "NOT_RUN") {
    return {
      status: "NOT_RUN",
      reason:
        providerState.missing.length > 0
          ? `Real provider configuration missing: ${providerState.missing.join(", ")}`
          : caseDefinition.blockingReason,
    };
  }
  return {
    status: caseDefinition.expectedStatus,
    reason: caseDefinition.blockingReason,
  };
};

const capabilities = catalog.capabilities.map((capability) => {
  const selected = selectedIds.has(capability.capabilityId);
  const selectedCases = selected
    ? [
        ...levelCases.filter(
          (item) => item.capabilityId === capability.capabilityId,
        ),
        {
          ...capability.l3,
          ...realCaseStatus({
            ...capability.l3,
            capabilityId: capability.capabilityId,
          }),
          sourceSuites:
            capability.l3.testFile === null ? [] : [capability.l3.testFile],
          failures:
            capability.l3.testFile === null
              ? []
              : assertionFailures.filter(
                  (failure) => failure.suiteFile === capability.l3.testFile,
                ),
          evidenceFiles:
            realCaseStatus({
              ...capability.l3,
              capabilityId: capability.capabilityId,
            }).evidenceFiles ?? [],
        },
      ]
    : [];
  const cases =
    selectedCases.length > 0
      ? selectedCases
      : ["L1", "L2", "L3"].map((evidenceLevel) => {
          if (evidenceLevel === "L3") {
            const blocked =
              capability.l3.expectedStatus.startsWith("BLOCKED_BY_");
            return {
              ...capability.l3,
              capabilityId: capability.capabilityId,
              status: blocked ? capability.l3.expectedStatus : "NOT_RUN",
              sourceSuites: [],
              failures: [],
              reason: blocked
                ? capability.l3.blockingReason
                : "Not selected in this qualification batch.",
            };
          }
          return {
            caseId: `${capability.capabilityId}-${evidenceLevel}`,
            capabilityId: capability.capabilityId,
            evidenceLevel,
            providerMode: evidenceLevel === "L3" ? "REAL" : "NONE",
            requiresPersistence: evidenceLevel !== "L1",
            requiresRestart: capability.capabilityId === "B12",
            expectedStatus: "NOT_RUN",
            status: "NOT_RUN",
            sourceSuites: [],
            reason: "Not selected in this qualification batch.",
            failures: [],
          };
        });
  const statusForLevel = (level) => {
    const statuses = cases
      .filter((item) => item.evidenceLevel === level)
      .map((item) => item.status);
    if (statuses.length === 0) {
      return "NOT_RUN";
    }
    if (statuses.includes("FAIL")) {
      return "FAIL";
    }
    if (statuses.includes("BLOCKED_BY_DESIGN_GAP")) {
      return "BLOCKED_BY_DESIGN_GAP";
    }
    if (statuses.includes("BLOCKED_BY_IMPLEMENTATION")) {
      return "BLOCKED_BY_IMPLEMENTATION";
    }
    if (statuses.every((status) => status === "NOT_RUN")) {
      return "NOT_RUN";
    }
    if (statuses.every((status) => status === "PASS")) {
      return "PASS";
    }
    return "NOT_RUN";
  };
  return {
    capabilityId: capability.capabilityId,
    title: capability.title,
    selected,
    l1Status: statusForLevel("L1"),
    l2Status: statusForLevel("L2"),
    l3Status: statusForLevel("L3"),
    providerModes: unique(cases.map((item) => item.providerMode)),
    evidenceFiles: unique(
      cases.flatMap((item) => [
        ...(item.sourceSuites ?? []),
        ...(item.evidenceFiles ?? []),
      ]),
    ),
    blockingReasons: cases
      .filter((item) => item.reason !== undefined)
      .map((item) => `${item.caseId}: ${item.reason}`),
    cases,
  };
});

const report = {
  schemaVersion: "arbor-capability-report-v1",
  runId,
  mode,
  selectedCapabilities: [...selectedIds],
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    vitestVersion: "5.0.1",
    providerMode: mode === "real-provider" ? "REAL" : "RECORDING/NONE",
    providerConfiguration: {
      ready: providerState.ready,
      ...(providerState.ready
        ? {
            provider: "openai-compatible",
            model: process.env.ARBOR_CAPABILITY_MODEL,
            endpoint: process.env.ARBOR_CAPABILITY_PROVIDER_URL,
            serverBuildId: process.env.ARBOR_CAPABILITY_SERVER_BUILD_ID,
            authMode: process.env.ARBOR_CAPABILITY_AUTH,
          }
        : { missing: providerState.missing }),
    },
  },
  suiteInventory: inventory?.combined?.totals ?? null,
  executedRuns: runResults.map((run) => ({
    exitCode: run.exitCode,
    totalTests: run.report?.numTotalTests ?? 0,
    passedTests: run.report?.numPassedTests ?? 0,
    failedTests: run.report?.numFailedTests ?? 0,
    totalSuites: run.report?.numTotalTestSuites ?? 0,
    passedSuites: run.report?.numPassedTestSuites ?? 0,
    failedSuites: run.report?.numFailedTestSuites ?? 0,
    testFiles: (run.report?.testResults ?? []).map((suite) =>
      normalize(relative(repoRoot, suite.name)),
    ),
  })),
  assertionFailures,
  notes: runNotes,
  capabilities,
};

mkdirSync(reportRoot, { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const markdown = [
  `# Arbor Capability Report`,
  ``,
  `- Run: \`${runId}\``,
  `- Mode: \`${mode}\``,
  `- Started: ${report.startedAt}`,
  `- Node / Vitest: ${report.runtime.node} / ${report.runtime.vitestVersion}`,
  `- Provider ready: ${report.runtime.providerConfiguration.ready}`,
  `- JSON evidence: \`${normalize(relative(repoRoot, reportPath))}\``,
  ``,
  `| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |`,
  `|---|---|---|---|---|---|`,
  ...capabilities.map(
    (item) =>
      `| ${item.capabilityId} ${item.title} | ${item.l1Status} | ${item.l2Status} | ${item.l3Status} | ${item.providerModes.join(", ")} | ${item.blockingReasons.join("; ").replaceAll("|", "\\|")} |`,
  ),
  ``,
  `## Executed suites`,
  ``,
  ...report.executedRuns.flatMap((run, index) => [
    `Run ${index + 1}: ${run.passedTests}/${run.totalTests} tests passed; ${run.failedTests} failed.`,
    ...run.testFiles.map((file) => `- \`${file}\``),
    ``,
  ]),
  ...(assertionFailures.length === 0
    ? ["No failing test assertions were reported."]
    : [
        "Failing assertions:",
        ...assertionFailures.map(
          (failure) => `- \`${failure.suiteFile}\`: ${failure.testName}`,
        ),
      ]),
  ``,
  ...runNotes,
].join("\n");
writeFileSync(markdownPath, `${markdown}\n`);

console.log(
  JSON.stringify(
    {
      report: normalize(relative(repoRoot, reportPath)),
      markdown: normalize(relative(repoRoot, markdownPath)),
      testTotals: report.executedRuns.map((run) => ({
        total: run.totalTests,
        passed: run.passedTests,
        failed: run.failedTests,
      })),
      capabilities: capabilities.map((item) => ({
        capabilityId: item.capabilityId,
        L1: item.l1Status,
        L2: item.l2Status,
        L3: item.l3Status,
      })),
    },
    null,
    2,
  ),
);

if (runResults.some((run) => run.exitCode !== 0)) {
  process.exitCode = 1;
}
