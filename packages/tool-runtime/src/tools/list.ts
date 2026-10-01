import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import {
  bounded,
  type ToolExecutionResult,
  type ToolExecutor,
} from "../runtime.js";
import { resolveExistingWithin } from "../safe-path.js";
import { executeFilesystemTool } from "./filesystem-result.js";

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
    const safeAbsolute = resolveExistingWithin(root, relative(root, absolute));
    const rel = relative(root, absolute);
    out.push(statSync(safeAbsolute).isDirectory() ? `${rel}/` : rel);
    if (statSync(safeAbsolute).isDirectory()) {
      walk(root, safeAbsolute, depth + 1, maxDepth, out);
    }
  }
};

/** P12 `12` §6: a non-`read`/`patch`/`shell` builtin. ReadOnly. */
export const listExecutor: ToolExecutor = {
  name: "list",
  write: false,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync(
      (): ToolExecutionResult =>
        executeFilesystemTool(() => {
          const args = JSON.parse(intent.argumentsJson) as {
            path: { path: string };
            depth?: number;
          };
          const start = resolveExistingWithin(sandbox.rootPath, args.path.path);
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
    ),
};
