import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vitestCli = resolve(repoRoot, "node_modules/vitest/vitest.mjs");
const outputFile = resolve(
  repoRoot,
  "planning/testing/core-capability/suite-evidence-inventory.json",
);

const mixedFiles = new Set([
  "apps/single-workspace/test/p14-real-provider-conversation.test.ts",
  "apps/web/test/session.test.tsx",
  "tests/p6-acceptance.test.ts",
  "tests/p7-acceptance.test.ts",
  "tests/p8-acceptance.test.ts",
  "tests/p9-acceptance.test.ts",
  "tests/p10-acceptance.test.ts",
  "tests/p11-acceptance.test.ts",
  "tests/p12-region-encoding.test.ts",
  "tests/p12-security-performance.test.ts",
]);

const mixedReasons = new Map([
  [
    "apps/single-workspace/test/p14-real-provider-conversation.test.ts",
    "The suite has a scripted-fetch context/persistence case plus a live-provider branch guarded by ARBOR_WAVE1_LIVE_HUMAN_INPUT; both seed input directly and neither is full B01 L3.",
  ],
  [
    "apps/web/test/session.test.tsx",
    "The suite mixes direct session-storage component behavior with user-facing navigation/session transitions.",
  ],
  [
    "tests/p6-acceptance.test.ts",
    "SQLite formation/governance stories share the file with direct model-contract/program probes.",
  ],
  [
    "tests/p7-acceptance.test.ts",
    "Database-backed deliverable/dependency stories share the file with direct matcher and replay probes.",
  ],
  [
    "tests/p8-acceptance.test.ts",
    "SQLite verification/acceptance lifecycle stories share the file with direct domain and program-contract probes.",
  ],
  [
    "tests/p9-acceptance.test.ts",
    "Fault-injected SQLite recovery stories share the file with source-level mechanical coverage checks.",
  ],
  [
    "tests/p10-acceptance.test.ts",
    "Application/read-model integration stories share the file with mechanical source/contract assertions.",
  ],
  [
    "tests/p11-acceptance.test.ts",
    "SQLite worktree/revision integration stories share the file with static boundary and closure assertions.",
  ],
  [
    "tests/p12-region-encoding.test.ts",
    "Direct region algebra cases share the file with persistence/runtime encoding integration checks.",
  ],
  [
    "tests/p12-security-performance.test.ts",
    "Direct trust/performance assertions share the file with source-tree architecture checks.",
  ],
]);

const unknownFiles = new Set([
  "tests/convergence/result-record.test.ts",
  "tests/p9-harness.test.ts",
  "tests/p12-closure.test.ts",
  ...[
    "d0-contract-guardrails.test.ts",
    "dependency-pins.test.ts",
    "no-forbidden-controls.test.tsx",
    "queue-proof.test.ts",
    "runtime-seams.test.ts",
    "tree-readonly.test.ts",
    "tokens.test.ts",
  ].map((name) => `apps/web/test/${name}`),
]);

const l1Exceptions = new Set([
  "tests/capability/harness.test.ts",
  "tests/p2-domain-evolution.test.ts",
  "tests/p2-ports.test.ts",
  "tests/p3-ports.test.ts",
  "tests/p4-ports.test.ts",
  "tests/p6-ceiling.test.ts",
  "tests/p7-domain.test.ts",
  "tests/p8-domain.test.ts",
  "tests/p10-domain-events.test.ts",
  "tests/p11-snapshot-fingerprint.test.ts",
]);

const l1AdapterFiles = new Set([
  "adapters/persistence-sqlite/test/runtime.test.ts",
  "adapters/persistence-sqlite/test/skeleton.test.ts",
]);

const l1SingleWorkspaceFiles = new Set([
  "apps/single-workspace/test/conversation-progress.test.ts",
  "apps/single-workspace/test/p13-invalidation.test.ts",
]);

const l2WebFiles = new Set([
  "apps/web/test/ws-invalidation-query.test.tsx",
  "apps/web/test/workbench-shell.test.tsx",
]);

const exactL3Files = new Set([
  "apps/single-workspace/test/p13-web-e2e.test.ts",
]);

const normalize = (path) => path.split(sep).join("/");

const classify = (suiteFile) => {
  if (suiteFile.startsWith("tests/capability/real-provider/")) {
    return {
      evidenceLevel: "L3",
      classification: "CAPABILITY",
      rationale:
        "Isolated real-provider tests enter through public HTTP commands and assert externally projected conversation outcomes.",
    };
  }
  if (exactL3Files.has(suiteFile)) {
    return {
      evidenceLevel: "L3",
      classification: "CAPABILITY",
      rationale:
        "Real composition and persistence are reached through HTTP/WebSocket; assertions observe external responses/effects.",
    };
  }
  if (mixedFiles.has(suiteFile)) {
    return {
      evidenceLevel: "MIXED",
      classification: "MIXED",
      rationale: mixedReasons.get(suiteFile),
    };
  }
  if (
    unknownFiles.has(suiteFile) ||
    suiteFile.startsWith("tests/architecture/") ||
    suiteFile.startsWith("tests/harness/")
  ) {
    return {
      evidenceLevel: "UNKNOWN",
      classification: "UNKNOWN",
      rationale:
        "The suite primarily inspects source, wiring, frozen declarations, harness behavior, or result records rather than exercising a runtime capability path.",
    };
  }
  if (
    suiteFile.startsWith("packages/") ||
    suiteFile.startsWith("adapters/environment-local/test/") ||
    suiteFile.startsWith("adapters/provider-openai/test/") ||
    l1AdapterFiles.has(suiteFile) ||
    l1SingleWorkspaceFiles.has(suiteFile) ||
    l1Exceptions.has(suiteFile) ||
    (suiteFile.startsWith("apps/web/test/") && !l2WebFiles.has(suiteFile))
  ) {
    return {
      evidenceLevel: "L1",
      classification: "COMPONENT",
      rationale:
        "The suite exercises one component/package contract or a direct UI/helper unit without an end-to-end production composition.",
    };
  }
  if (
    suiteFile.startsWith("adapters/") ||
    suiteFile.startsWith("apps/single-workspace/test/") ||
    suiteFile.startsWith("apps/web/test/") ||
    suiteFile.startsWith("tests/")
  ) {
    return {
      evidenceLevel: "L2",
      classification: "INTEGRATION",
      rationale:
        "The suite composes multiple modules, an adapter, persistence, or a transport seam, but does not meet the externally observable capability criteria for L3.",
    };
  }
  return {
    evidenceLevel: "UNKNOWN",
    classification: "UNKNOWN",
    rationale: "No reviewed cohort rule matches this test file.",
  };
};

const collect = (configPath, cwd = repoRoot) => {
  const args = [vitestCli, "list", "--no-staticParse", "--json"];
  if (configPath !== undefined) {
    args.push("--config", configPath);
  }
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Vitest collection failed (${configPath ?? "root"}): ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout);
};

const summarize = (tests) => {
  const suites = new Map();
  for (const test of tests) {
    const suiteFile = normalize(relative(repoRoot, test.file));
    const suite = suites.get(suiteFile) ?? {
      suiteFile,
      testCases: 0,
      testNames: [],
    };
    suite.testCases += 1;
    suite.testNames.push(test.name);
    suites.set(suiteFile, suite);
  }
  const records = [...suites.values()]
    .sort((left, right) => left.suiteFile.localeCompare(right.suiteFile))
    .map((suite) => ({
      ...suite,
      ...classify(suite.suiteFile),
    }));
  const totals = {
    files: records.length,
    cases: records.reduce((sum, record) => sum + record.testCases, 0),
    byLevel: {},
  };
  for (const record of records) {
    const bucket = totals.byLevel[record.evidenceLevel] ?? {
      files: 0,
      cases: 0,
    };
    bucket.files += 1;
    bucket.cases += record.testCases;
    totals.byLevel[record.evidenceLevel] = bucket;
  }
  return { totals, suites: records };
};

const root = summarize(collect(undefined));
const webRoot = resolve(repoRoot, "apps/web");
const web = summarize(collect("vitest.config.ts", webRoot));
const realProvider = summarize(collect("vitest.capability-real.config.ts"));
const combinedSuites = [...root.suites, ...web.suites].sort((left, right) =>
  left.suiteFile.localeCompare(right.suiteFile),
);
const combined = {
  files: combinedSuites.length,
  cases: combinedSuites.reduce((sum, suite) => sum + suite.testCases, 0),
  byLevel: {},
};
for (const suite of combinedSuites) {
  const bucket = combined.byLevel[suite.evidenceLevel] ?? {
    files: 0,
    cases: 0,
  };
  bucket.files += 1;
  bucket.cases += suite.testCases;
  combined.byLevel[suite.evidenceLevel] = bucket;
}

const inventory = {
  schemaVersion: "arbor-suite-evidence-inventory-v1",
  generatedAt: new Date().toISOString(),
  vitestVersion: "5.0.1",
  method:
    "Vitest list --no-staticParse imports suite definitions without executing test bodies; tier is a reviewed file-cohort classification, with mixed suites explicitly retained.",
  root,
  web,
  realProvider,
  combined: { totals: combined, suites: combinedSuites },
};

mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      root: root.totals,
      web: web.totals,
      realProvider: realProvider.totals,
      combined,
    },
    null,
    2,
  ),
);
