import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";

const root = resolve(import.meta.dirname, "../..");
const sourceRoots = ["packages", "adapters", "apps"];

const walk = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      ["dist", "node_modules", "public", "test", "tests"].includes(entry.name)
    ) {
      continue;
    }
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(file);
  }
  return files;
};

const sourceFiles = sourceRoots.flatMap((directory) => {
  const absolute = join(root, directory);
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => walk(join(absolute, entry.name, "src")));
});

const branchNodes = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchCase",
  "ConditionalExpression",
  "CatchClause",
  "LogicalExpression",
]);
const functionNodes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

const complexityFor = (file) => {
  const source = readFileSync(file, "utf8");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx", "importMeta", "topLevelAwait"],
  });
  let complexity = 1;
  let branches = 0;
  let functions = 0;
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (branchNodes.has(node.type)) {
      complexity += 1;
      branches += 1;
    }
    if (functionNodes.has(node.type)) functions += 1;
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "tokens", "comments"].includes(key))
        continue;
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(ast);
  return {
    file: relative(root, file),
    lines: source.split(/\r?\n/).length,
    complexity,
    branches,
    functions,
  };
};

const packageManifests = sourceRoots.flatMap((directory) => {
  const absolute = join(root, directory);
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(absolute, entry.name, "package.json"))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
});

const packageGraph = new Map();
for (const file of packageManifests) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  })
    .filter((name) => name.startsWith("@arbor/"))
    .map((name) => name.slice("@arbor/".length));
  packageGraph.set(manifest.name.slice("@arbor/".length), dependencies);
}

const cycles = [];
const visitPackage = (name, path = []) => {
  const index = path.indexOf(name);
  if (index >= 0) {
    cycles.push([...path.slice(index), name]);
    return;
  }
  for (const dependency of packageGraph.get(name) ?? []) {
    if (packageGraph.has(dependency)) visitPackage(dependency, [...path, name]);
  }
};
for (const name of packageGraph.keys()) visitPackage(name);

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const baseSha =
  process.env.ARBOR_BASE_SHA ||
  git(["merge-base", "HEAD", "origin/master"]) ||
  "";

const parseKnownProblems = (text) => {
  const problemBlocks = text
    .split(/(?=^## KP-)/m)
    .filter((block) => /^## KP-/.test(block));
  return problemBlocks.map((block) => ({
    id: block.match(/^## (KP-\d+)/)?.[1] ?? "unknown",
    priority: block.match(/\*\*优先级\*\*\s*\n([^\n]+)/)?.[1] ?? "UNSET",
  }));
};

const problemText = readFileSync(join(root, "docs/KNOWN_PROBLEMS.md"), "utf8");
const problems = parseKnownProblems(problemText);
const baseProblemText = (() => {
  if (!baseSha) return null;
  try {
    return execFileSync("git", ["show", `${baseSha}:docs/KNOWN_PROBLEMS.md`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
})();
const baseProblems = baseProblemText ? parseKnownProblems(baseProblemText) : [];
const baseProblemsById = new Map(
  baseProblems.map((problem) => [problem.id, problem]),
);
const baselineInitialized = baseProblemText === null;
const newP0Problems = baselineInitialized
  ? []
  : problems.filter((problem) => {
      if (!problem.priority.startsWith("P0")) return false;
      return !baseProblemsById.get(problem.id)?.priority.startsWith("P0");
    });

const readJsonFile = (file) => {
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const changedFiles = baseSha
  ? git(["diff", "--name-only", `${baseSha}...HEAD`])
      .split(/\r?\n/)
      .filter(Boolean)
  : [];

const changedProductionFiles = new Set(
  changedFiles.filter((file) =>
    /^(packages|adapters|apps)\/.*\/src\/.*\.(ts|tsx)$/.test(file),
  ),
);

const diffStats = baseSha
  ? git(["diff", "--numstat", `${baseSha}...HEAD`])
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce(
        (stats, line) => {
          const [added, deleted] = line.split(/\s+/);
          if (/^\d+$/.test(added)) stats.addedLines += Number(added);
          if (/^\d+$/.test(deleted)) stats.deletedLines += Number(deleted);
          stats.files += 1;
          return stats;
        },
        { files: 0, addedLines: 0, deletedLines: 0 },
      )
  : { files: 0, addedLines: 0, deletedLines: 0 };

const whitespaceErrors = (() => {
  if (!baseSha) return [];
  try {
    execFileSync("git", ["diff", "--check", `${baseSha}...HEAD`], {
      cwd: root,
      encoding: "utf8",
    });
    return [];
  } catch (error) {
    return String(error.stdout ?? "")
      .split(/\r?\n/)
      .filter(Boolean);
  }
})();

const historyCommitCount = (file) =>
  git(["log", "--format=%H", "-n", "100", "--", file])
    .split(/\r?\n/)
    .filter(Boolean).length;

const coChangePairs = () => {
  if (!baseSha || changedProductionFiles.size < 2) return [];
  const commits = git([
    "log",
    "--format=%H",
    "-n",
    "200",
    "--",
    ...changedProductionFiles,
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  const counts = new Map();
  for (const commit of commits) {
    const files = git([
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      commit,
    ])
      .split(/\r?\n/)
      .filter((file) => changedProductionFiles.has(file))
      .sort();
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        const key = `${files[i]} :: ${files[j]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([pair, commits]) => ({ pair, commits }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 20);
};

const coverageFromReport = () => {
  const summary = readJsonFile(join(root, "coverage", "coverage-summary.json"));
  if (summary?.total)
    return { source: "coverage-summary.json", ...summary.total };
  const final = readJsonFile(join(root, "coverage", "coverage-final.json"));
  if (!final) return { source: "not-collected" };
  const totals = {
    statements: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
    lines: { total: 0, covered: 0 },
  };
  for (const file of Object.values(final)) {
    for (const [key, map] of [
      ["statements", file.s],
      ["functions", file.f],
      ["branches", file.b],
    ]) {
      if (!map) continue;
      const values = Object.values(map);
      totals[key].total += values.length;
      totals[key].covered += values.filter((value) => value > 0).length;
    }
    const lines = new Map();
    for (const [id, location] of Object.entries(file.statementMap ?? {})) {
      const line = location?.start?.line;
      if (line !== undefined) lines.set(line, file.s?.[id] ?? 0);
    }
    totals.lines.total += lines.size;
    totals.lines.covered += [...lines.values()].filter(
      (value) => value > 0,
    ).length;
  }
  return {
    source: "coverage-final.json",
    ...Object.fromEntries(
      Object.entries(totals).map(([key, value]) => [
        key,
        {
          ...value,
          pct: value.total ? (value.covered / value.total) * 100 : 100,
        },
      ]),
    ),
  };
};

const auditReport = readJsonFile(process.env.ARBOR_AUDIT_JSON);
const auditVulnerabilities =
  auditReport?.metadata?.vulnerabilities ??
  auditReport?.vulnerabilities ??
  null;
const auditFailed =
  process.env.ARBOR_AUDIT_STATUS &&
  process.env.ARBOR_AUDIT_STATUS !== "success";
const auditReportMissing =
  Boolean(process.env.ARBOR_AUDIT_JSON) && !auditReport;
const security = auditVulnerabilities
  ? {
      source: "pnpm audit --prod --audit-level high",
      status: "collected",
      critical: Number(auditVulnerabilities.critical ?? 0),
      high: Number(auditVulnerabilities.high ?? 0),
      moderate: Number(auditVulnerabilities.moderate ?? 0),
      low: Number(auditVulnerabilities.low ?? 0),
      info: Number(auditVulnerabilities.info ?? 0),
    }
  : {
      source: "not-collected",
      status: auditFailed ? "failed" : "not-run",
    };

const pullRequest = readJsonFile(process.env.GITHUB_EVENT_PATH)?.pull_request;
const prCycleTimeHours = pullRequest?.created_at
  ? (Date.now() - Date.parse(pullRequest.created_at)) / 3_600_000
  : null;

const runJscpd = () => {
  const output = mkdtempSync(join(tmpdir(), "arbor-health-jscpd-"));
  try {
    execFileSync(
      "pnpm",
      [
        "exec",
        "jscpd",
        "packages",
        "adapters",
        "apps",
        "--pattern",
        "**/src/**/*.{ts,tsx}",
        "--format",
        "typescript,tsx",
        "--ignore",
        "**/test/**,**/tests/**,**/public/**,**/dist/**",
        "--min-lines",
        "8",
        "--min-tokens",
        "50",
        "--reporters",
        "json",
        "--report-name",
        "health",
        "--output",
        output,
        "--no-colors",
        "--silent",
        "--exit-code",
        "0",
      ],
      { cwd: root, stdio: "ignore" },
    );
    const report = JSON.parse(
      readFileSync(join(output, "health.json"), "utf8"),
    );
    const total = report.statistics?.total ?? {};
    return {
      files: total.sources ?? 0,
      lines: total.lines ?? 0,
      clones: total.clones ?? 0,
      duplicatedLines: total.duplicatedLines ?? 0,
      duplicatedTokens: total.duplicatedTokens ?? 0,
      duplicatedLineRatio: total.percentage ?? 0,
    };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
};

const complexity = sourceFiles.map(complexityFor);
const changedHotspots = complexity
  .filter((file) => changedProductionFiles.has(file.file))
  .map((file) => {
    const recentCommits = historyCommitCount(file.file);
    return {
      file: file.file,
      complexity: file.complexity,
      lines: file.lines,
      recentCommits,
      riskScore: file.complexity * (1 + recentCommits),
    };
  })
  .sort((a, b) => b.riskScore - a.riskScore)
  .slice(0, 20);
const duplication = runJscpd();
const summary = {
  generatedAt: new Date().toISOString(),
  commit: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain"]).length > 0,
  source: {
    files: complexity.length,
    lines: complexity.reduce((sum, file) => sum + file.lines, 0),
    complexitySum: complexity.reduce((sum, file) => sum + file.complexity, 0),
    filesOver500Lines: complexity.filter((file) => file.lines > 500).length,
    filesOver1000Lines: complexity.filter((file) => file.lines > 1000).length,
    topComplexity: [...complexity]
      .sort((a, b) => b.complexity - a.complexity)
      .slice(0, 20),
  },
  change: {
    baseSha: baseSha || null,
    ...diffStats,
    churn: diffStats.addedLines + diffStats.deletedLines,
    whitespaceErrors,
  },
  coverage: coverageFromReport(),
  duplication,
  hotspotRisk: changedHotspots,
  changeCoupling: coChangePairs(),
  pullRequest: {
    cycleTimeHours: prCycleTimeHours,
    source:
      prCycleTimeHours === null
        ? "not-a-pull-request"
        : "pull_request.created_at",
  },
  packages: {
    count: packageGraph.size,
    cycles,
  },
  knownProblems: {
    p0: problems.filter((problem) => problem.priority.startsWith("P0")).length,
    p1: problems.filter((problem) => problem.priority.startsWith("P1")).length,
    newP0: newP0Problems.length,
    newP0Ids: newP0Problems.map((problem) => problem.id),
    baselineInitialized,
    ids: problems,
  },
  security,
  technicalDebt: {
    source: process.env.ARBOR_SONAR_REPORT
      ? "sonarqube-report"
      : "not-configured",
    ratio:
      readJsonFile(process.env.ARBOR_SONAR_REPORT)?.technicalDebtRatio ?? null,
  },
  releaseStatus: {
    status: "requires-ci-results",
    blockers: [
      ...(cycles.length > 0 ? [`package cycles: ${cycles.length}`] : []),
      ...(newP0Problems.length > 0
        ? [
            `new P0 problems: ${newP0Problems.map((problem) => problem.id).join(", ")}`,
          ]
        : []),
      ...(whitespaceErrors.length > 0
        ? [`diff check errors: ${whitespaceErrors.length}`]
        : []),
      ...(security.critical > 0 || security.high > 0
        ? [
            `security vulnerabilities: critical=${security.critical}, high=${security.high}`,
          ]
        : []),
      ...(auditReportMissing
        ? ["dependency audit did not produce a report"]
        : []),
      ...(auditFailed &&
      auditReport &&
      security.critical === 0 &&
      security.high === 0
        ? ["dependency audit failed without high/critical findings"]
        : []),
      ...(duplication.duplicatedLineRatio > 5
        ? [`duplication ratio above 5%: ${duplication.duplicatedLineRatio}`]
        : []),
      ...(coverageFromReport().source === "not-collected"
        ? ["coverage report missing"]
        : []),
    ],
  },
};

summary.metricChecks = {
  buildAndTests: {
    source: "CI quality steps",
    status: "required",
    note: "Build, lint, typecheck, architecture, core, coverage and Web checks run before this snapshot.",
  },
  newSevereDefects: {
    source: "docs/KNOWN_PROBLEMS.md delta",
    status:
      newP0Problems.length > 0
        ? "fail"
        : baselineInitialized
          ? "baseline-required"
          : "pass",
    newP0: newP0Problems.length,
    newP0Ids: newP0Problems.map((problem) => problem.id),
  },
  security: {
    source: "CodeQL + pnpm audit --prod --audit-level high",
    ...security,
    status:
      auditFailed || (process.env.ARBOR_AUDIT_JSON && !auditReport)
        ? "fail"
        : security.source === "not-collected"
          ? "required"
          : security.critical > 0 || security.high > 0
            ? "fail"
            : "pass",
  },
  complexity: {
    source: "TypeScript AST",
    status: "reported",
    files: complexity.length,
    top: summary.source.topComplexity,
  },
  duplication: {
    source: "jscpd",
    status: duplication.duplicatedLineRatio > 5 ? "fail" : "pass",
    ratio: duplication.duplicatedLineRatio,
  },
  coverage: {
    source: summary.coverage.source,
    status: summary.coverage.source === "not-collected" ? "fail" : "pass",
    report: summary.coverage,
  },
  technicalDebtRatio: {
    source: process.env.ARBOR_SONAR_REPORT
      ? "SonarQube report"
      : "SonarQube not configured",
    status: process.env.ARBOR_SONAR_REPORT ? "reported" : "not-configured",
    ratio: summary.technicalDebt.ratio,
  },
  codeChurn: {
    source: "git diff",
    status: "reported",
    ...summary.change,
  },
  hotspotRisk: {
    source: "git history + TypeScript AST",
    status: "reported",
    files: summary.hotspotRisk,
  },
  circularDependencies: {
    source: "package dependency graph",
    status: cycles.length > 0 ? "fail" : "pass",
    cycles,
  },
  changeCoupling: {
    source: "git co-change history",
    status: "reported",
    pairs: summary.changeCoupling,
  },
  prCycleTime: {
    source: "GitHub pull_request.created_at",
    status: prCycleTimeHours === null ? "unavailable" : "reported",
    cycleTimeHours: prCycleTimeHours,
  },
};

if (process.argv.includes("--enforce")) {
  const blockers = summary.releaseStatus.blockers;
  if (blockers.length > 0) {
    console.error(`health gate failed: ${blockers.join("; ")}`);
    process.exitCode = 1;
  }
}

console.log(JSON.stringify(summary, null, 2));
