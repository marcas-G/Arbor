import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, moduleOf, collectExactRefs, summarize } from "./inventory-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const head = git(["rev-parse", "HEAD"]).trim();
const statusBefore = git(["status", "--porcelain", "-z"]);
const paths = [...new Set(git(["ls-files", "-z"]).split("\0").filter(Boolean))].sort();
const tracked = new Set(paths);
const assets = paths.map(path => ({ path, kind: classify(path), module: moduleOf(path) }));
const references = [];
const readErrors = [];
for (const path of paths.filter(p => p.endsWith(".md"))) {
  try {
    for (const target of collectExactRefs(readFileSync(join(root, path), "utf8"))) {
      references.push({ source: path, target, tracked: tracked.has(target) });
    }
  } catch (error) {
    readErrors.push({ path, error: String(error) });
  }
}
const statusAfter = git(["status", "--porcelain", "-z"]);
const headAfter = git(["rev-parse", "HEAD"]).trim();
console.log(JSON.stringify({
  schema: "arbor/repository-inventory/v1",
  head, dirty: Boolean(statusBefore || statusAfter), headChanged: head !== headAfter,
  statusChanged: statusBefore !== statusAfter,
  scope: "Tracked index paths and working-tree Markdown; exact root-relative inline-code references only; no claim about Markdown anchors, dynamic references, or semantic validity.",
  ...summarize(assets), assets, references, readErrors,
  missingReferences: references.filter(ref => !ref.tracked)
}, null, 2));
if (readErrors.length || head !== headAfter || statusBefore !== statusAfter) process.exitCode = 1;
