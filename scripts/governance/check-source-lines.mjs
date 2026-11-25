import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectFile, isSource, lineCount } from "./source-lines-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--baseline")) {
  throw new Error("Usage: check-source-lines.mjs [--baseline <commit>]");
}
const baseline = args.length
  ? git(["rev-parse", "--verify", args[1] + "^{commit}"]).trim()
  : null;
const head = git(["rev-parse", "HEAD"]).trim();
const before = git(["status", "--porcelain", "-z"]);
const paths = [...new Set(git(["ls-files", "-z"]).split("\0").filter(Boolean))]
  .filter(isSource)
  .sort();
const baselinePaths =
  baseline === null
    ? new Set()
    : new Set(
        git(["ls-tree", "-r", "--name-only", "-z", baseline]).split("\0"),
      );
const findings = [];
const errors = [];
for (const path of paths) {
  try {
    const content = readFileSync(join(root, path), "utf8");
    if (lineCount(content) <= 800) continue;
    const baselineCount =
      baseline !== null && baselinePaths.has(path)
        ? lineCount(git(["show", baseline + ":" + path]))
        : undefined;
    const finding = inspectFile(path, content, baselineCount);
    if (finding) findings.push(finding);
  } catch (error) {
    errors.push({ path, error: String(error) });
  }
}
findings.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
const changed =
  git(["rev-parse", "HEAD"]).trim() !== head ||
  git(["status", "--porcelain", "-z"]) !== before;
const blocking = findings.filter(
  (finding) => baseline === null || !finding.legacy,
);
console.log(
  JSON.stringify(
    {
      schema: "arbor/source-lines/v1",
      maxLines: 800,
      mode: baseline === null ? "strict" : "transition",
      baseline,
      head,
      dirty: Boolean(before),
      changed,
      scanned: paths.length,
      overLimit: findings.length,
      blocking: blocking.length,
      findings,
      errors,
    },
    null,
    2,
  ),
);
if (blocking.length || errors.length || changed) process.exitCode = 1;
