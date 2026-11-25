import { lstatSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import type { ToolExecutionResult, ToolExecutor } from "../runtime.js";
import { bounded } from "../runtime.js";
import { resolveSandboxTarget } from "../sandbox-target.js";
import { executeFilesystemTool } from "./filesystem-result.js";

/** Same single-file ceiling as the grep walker: a workspace-local file the
 * model asks to read must not be able to exhaust daemon memory. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** P4 `08` §2: ReadOnly. */
export const readExecutor: ToolExecutor = {
  name: "read",
  write: false,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync(
      (): ToolExecutionResult =>
        executeFilesystemTool(() => {
          const args = JSON.parse(intent.argumentsJson) as {
            target: { mount: string; path: string };
            offset?: number;
            limit?: number;
          };
          const resolved = resolveSandboxTarget(sandbox, args.target, {
            access: "ReadOnly",
          });
          const size = lstatSync(resolved).size;
          if (size > MAX_FILE_BYTES) {
            return {
              settlement: { _tag: "Success" },
              observation: bounded(
                JSON.stringify({
                  error: "file exceeds the read size limit",
                  byteSize: size,
                  limitBytes: MAX_FILE_BYTES,
                }),
              ),
              resultRef: null,
            };
          }
          const content = readFileSync(resolved, "utf8");
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
