import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isOutOfScope,
  isSourcePath,
  pathViolation,
  symbolViolation,
  testNameViolation,
} from "./semantic-naming-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const args = process.argv.slice(2);
const fullScan = args.length === 1 && args[0] === "--full";
if (
  !fullScan &&
  args.length !== 0 &&
  (args.length !== 2 || args[0] !== "--baseline")
) {
  throw new Error(
    "Usage: check-semantic-naming.mjs [--baseline <commit>] [--full]",
  );
}
const baseline =
  args.length === 2
    ? git(["rev-parse", "--verify", `${args[1]}^{commit}`]).trim()
    : null;
const head = git(["rev-parse", "HEAD"]).trim();
const before = git(["status", "--porcelain", "-z"]);

// HEAD may be dirty; the review set is the union of paths changed between the
// baseline tree and HEAD and paths differing from HEAD in the index/working
// tree (staged new files included, like check-source-lines enumerating the
// index). File content is read from the working tree so a local run reviews
// staged and unstaged work. Without --baseline the scan is strict: the whole
// tracked tree, every line — never a silent empty set.
const diffPaths = baseline
  ? [
      ...git([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        `${baseline}..HEAD`,
      ]).split("\0"),
      ...git(["diff", "--name-only", "--no-renames", "-z", "HEAD"]).split("\0"),
    ].filter(Boolean)
  : git(["ls-files", "-z"]).split("\0").filter(Boolean);
const wholeFile = baseline === null;
const changedSourcePaths = [...new Set(diffPaths)]
  .filter((path) => isSourcePath(path) && !isOutOfScope(path))
  .filter((path) => wholeFile || existsSync(join(root, path)))
  .sort();

// Legacy inventory exempted from the path category (never the line categories:
// a touched legacy file still must not add new planning-coded symbols/tests).
const baselinePathExemptions = new Set(
  (() => {
    try {
      const parsed = JSON.parse(
        readFileSync(
          join(root, "scripts/governance/naming-baseline.json"),
          "utf8",
        ),
      );
      return (parsed.exemptions?.paths ?? []).map((entry) => entry.path);
    } catch {
      return [];
    }
  })(),
);

const findings = [];
const errors = [];
for (const path of changedSourcePaths) {
  const pathFinding = pathViolation(path);
  if (pathFinding && (fullScan || !baselinePathExemptions.has(path))) {
    findings.push({ category: "path", path, evidence: path });
  }
  if (!fullScan && !pathFinding && baselinePathExemptions.has(path)) continue;
  let content;
  try {
    content = readFileSync(join(root, path), "utf8");
  } catch (error) {
    errors.push({ path, error: String(error) });
    continue;
  }
  const lineTexts = content.split(/\r\n|\n|\r/u);
  let addedLines;
  try {
    // Working tree (or HEAD when unchanged locally) versus the baseline tree:
    // the hunk heads describe every line the branch adds. Strict/full mode
    // has no baseline, so every line of the file is reviewed.
    if (wholeFile) {
      addedLines = new Set(
        Array.from({ length: lineTexts.length }, (_, index) => index + 1),
      );
    } else {
      const diff = git([
        "diff",
        "--no-color",
        "-U0",
        "--no-renames",
        baseline,
        "--",
        path,
      ]);
      addedLines = new Set(
        diff
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("@@"))
          .flatMap((header) => {
            const plus = header.slice(header.indexOf("+") + 1);
            const start = Number(plus.split(",")[0].split(" ")[0]);
            const count = Number((plus.split(",")[1] ?? "").split(" ")[0]) || 1;
            return Array.from({ length: count }, (_, index) => start + index);
          }),
      );
    }
  } catch (error) {
    errors.push({ path, error: String(error) });
    continue;
  }
  for (const number of [...addedLines].sort((a, b) => a - b)) {
    const line = lineTexts[number - 1];
    if (line === undefined) continue;
    // Comments quote historical names as documentation, not as new
    // declarations or test registrations.
    const code = line.replace(/\/\*.*?\*\//gu, "").replace(/\/\/.*$/u, "");
    const symbol = symbolViolation(code);
    if (symbol) {
      findings.push({
        category: "symbol",
        path,
        line: number,
        evidence: symbol.line,
        symbol: symbol.symbol,
      });
    }
    const testName = testNameViolation(code);
    if (testName) {
      findings.push({
        category: "test-name",
        path,
        line: number,
        evidence: testName.line,
      });
    }
  }
}

findings.sort(
  (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
);
const changed =
  git(["rev-parse", "HEAD"]).trim() !== head ||
  git(["status", "--porcelain", "-z"]) !== before;
console.log(
  JSON.stringify(
    {
      schema: "arbor/semantic-naming/v1",
      mode: fullScan ? "full" : baseline === null ? "strict" : "transition",
      baseline,
      head,
      dirty: Boolean(before),
      changed,
      scanned: changedSourcePaths.length,
      findingCount: findings.length,
      blocking: findings.length,
      findings,
      errors,
    },
    null,
    2,
  ),
);
if (findings.length || errors.length || changed) process.exitCode = 1;
