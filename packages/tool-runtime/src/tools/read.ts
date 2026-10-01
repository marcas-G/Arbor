import { readFileSync } from "node:fs";
import { Effect } from "effect";
import type { ToolExecutionResult, ToolExecutor } from "../runtime.js";
import { bounded } from "../runtime.js";
import { resolveExistingWithin } from "../safe-path.js";
import { executeFilesystemTool } from "./filesystem-result.js";

/** P4 `08` §2. ReadOnly. */
export const readExecutor: ToolExecutor = {
  name: "read",
  write: false,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync(
      (): ToolExecutionResult =>
        executeFilesystemTool(() => {
          const args = JSON.parse(intent.argumentsJson) as {
            path: { path: string };
            offset?: number;
            limit?: number;
          };
          const content = readFileSync(
            resolveExistingWithin(sandbox.rootPath, args.path.path),
            "utf8",
          );
          const offset = args.offset ?? 0;
          const limit = args.limit ?? content.length;
          const slice = content.slice(offset, offset + limit);
          return {
            settlement: { _tag: "Success" },
            observation: bounded(
              JSON.stringify({
                text: slice,
                truncated: slice.length < content.length - offset,
                byteSize: Buffer.byteLength(content),
              }),
            ),
            resultRef: null,
          };
        }),
    ),
};
