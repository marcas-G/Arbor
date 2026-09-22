import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

const MAX_ENTRIES = 500;

const walk = (
  root: string,
  current: string,
  depth: number,
  maxDepth: number,
  out: Array<string>,
): void => {
  if (depth > maxDepth || out.length >= MAX_ENTRIES) {
    return;
  }
  for (const entry of readdirSync(current)) {
    if (out.length >= MAX_ENTRIES) {
      return;
    }
    const absolute = join(current, entry);
    const rel = relative(root, absolute);
    out.push(statSync(absolute).isDirectory() ? `${rel}/` : rel);
    if (statSync(absolute).isDirectory()) {
      walk(root, absolute, depth + 1, maxDepth, out);
    }
  }
};

/** P12 `12` §6: a non-`read`/`patch`/`shell` builtin. ReadOnly. */
export const listExecutor: ToolExecutor = {
  name: "list",
  write: false,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync((): ToolExecutionResult => {
      const args = JSON.parse(intent.argumentsJson) as {
        path: { path: string };
        depth?: number;
      };
      const start = resolveWithin(sandbox.rootPath, args.path.path);
      const entries: Array<string> = [];
      walk(sandbox.rootPath, start, 0, args.depth ?? 1, entries);
      return {
        settlement: { _tag: "Success" },
        observation: bounded(
          JSON.stringify({
            entries,
            truncated: entries.length >= MAX_ENTRIES,
          }),
        ),
        resultRef: null,
      };
    }),
};
