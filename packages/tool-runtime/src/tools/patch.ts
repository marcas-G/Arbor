import { readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import {
  bounded,
  type ToolExecutionResult,
  type ToolExecutor,
} from "../runtime.js";
import { resolveExistingWithin } from "../safe-path.js";

const sameLines = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length &&
  left.every((line, index) => line === right[index]);

const applyDiff = (
  content: string,
  diff: string,
):
  | {
      readonly ok: true;
      readonly content: string;
      readonly hunks: number;
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly reason: string } => {
  const lines = content.split("\n");
  const diffLines = diff.split("\n");
  let index = 0;
  let hunks = 0;
  let delta = 0;
  let changed = false;
  while (index < diffLines.length) {
    const header = diffLines[index] ?? "";
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (match === null) {
      index += 1;
      continue;
    }
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? "1");
    const newCount = Number(match[4] ?? "1");
    const start = (oldStart === 0 ? 0 : oldStart - 1) + delta;
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (
      index < diffLines.length &&
      !(diffLines[index] ?? "").startsWith("@@")
    ) {
      const line = diffLines[index] ?? "";
      if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line !== "\\ No newline at end of file") {
        return { ok: false, reason: `invalid hunk line: ${line}` };
      }
      index += 1;
    }
    if (oldLines.length !== oldCount || newLines.length !== newCount) {
      return { ok: false, reason: "hunk line counts do not match header" };
    }
    const currentOld = lines.slice(start, start + oldLines.length);
    const currentNew = lines.slice(start, start + newLines.length);
    if (oldLines.length === 0 && sameLines(currentNew, newLines)) {
      // A pure insertion has no old context to distinguish first application
      // from replay. Exact target content at the insertion point means the
      // hunk is already applied.
    } else if (sameLines(currentOld, oldLines)) {
      lines.splice(start, oldLines.length, ...newLines);
      changed ||= !sameLines(oldLines, newLines);
    } else if (!sameLines(currentNew, newLines)) {
      return {
        ok: false,
        reason: `hunk context mismatch at old line ${oldStart}`,
      };
    }
    delta += newLines.length - oldLines.length;
    hunks += 1;
  }
  return { ok: true, content: lines.join("\n"), hunks, changed };
};

/** P4 `08` §3. Idempotent: same invocation key replay yields the same file. */
export const patchExecutor: ToolExecutor = {
  name: "patch",
  write: true,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync((): ToolExecutionResult => {
      const args = JSON.parse(intent.argumentsJson) as {
        path: { path: string };
        unifiedDiff: string;
      };
      const target = resolveExistingWithin(sandbox.rootPath, args.path.path);
      const content = readFileSync(target, "utf8");
      const applied = applyDiff(content, args.unifiedDiff);
      if (!applied.ok) {
        return {
          settlement: { _tag: "ExpectedFailure" },
          observation: bounded(applied.reason),
          resultRef: null,
        };
      }
      if (applied.hunks === 0) {
        return {
          settlement: { _tag: "ExpectedFailure" },
          observation: bounded("diff contained no applicable hunk"),
          resultRef: null,
        };
      }
      if (applied.changed) {
        writeFileSync(target, applied.content);
      }
      return {
        settlement: { _tag: "Success" },
        observation: bounded(
          JSON.stringify({ applied: applied.changed, hunks: applied.hunks }),
        ),
        resultRef: null,
      };
    }),
};
