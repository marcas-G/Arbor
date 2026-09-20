import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import {
  bounded,
  type ToolExecutionResult,
  type ToolExecutor,
} from "../runtime.js";

const resolveWithin = (root: string, path: string): string => {
  const target = resolve(join(root, path));
  if (!target.startsWith(resolve(root))) {
    throw new Error("path escapes sandbox root");
  }
  return target;
};

const applyDiff = (
  content: string,
  diff: string,
): { readonly content: string; readonly hunks: number } => {
  const lines = content.split("\n");
  const diffLines = diff.split("\n");
  let index = 0;
  let hunks = 0;
  while (index < diffLines.length) {
    const header = diffLines[index] ?? "";
    const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(header);
    if (match === null) {
      index += 1;
      continue;
    }
    const start = Number(match[1]) - 1;
    index += 1;
    const removed: string[] = [];
    const added: string[] = [];
    while (
      index < diffLines.length &&
      !(diffLines[index] ?? "").startsWith("@@")
    ) {
      const line = diffLines[index] ?? "";
      if (line.startsWith("-")) {
        removed.push(line.slice(1));
      } else if (line.startsWith("+")) {
        added.push(line.slice(1));
      }
      index += 1;
    }
    lines.splice(start, removed.length, ...added);
    hunks += 1;
  }
  return { content: lines.join("\n"), hunks };
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
      const target = resolveWithin(sandbox.rootPath, args.path.path);
      const content = readFileSync(target, "utf8");
      const { content: updated, hunks } = applyDiff(content, args.unifiedDiff);
      if (hunks === 0) {
        return {
          settlement: { _tag: "ExpectedFailure" },
          observation: bounded("diff contained no applicable hunk"),
          resultRef: null,
        };
      }
      writeFileSync(target, updated);
      return {
        settlement: { _tag: "Success" },
        observation: bounded(JSON.stringify({ applied: true, hunks })),
        resultRef: null,
      };
    }),
};
