import { lstatSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { RE2JS } from "re2js";
import type { ToolExecutor } from "../runtime.js";
import { executeFilesystemTool } from "./filesystem-result.js";
import {
  readRegularText,
  searchDepth,
  searchLimit,
  searchObservation,
  visitRegularFiles,
  type WalkedFile,
  withSandboxParent,
} from "./filesystem-walk.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export const grepExecutor: ToolExecutor = {
  name: "grep",
  write: false,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync(() =>
      executeFilesystemTool(() => {
        const args = JSON.parse(intent.argumentsJson) as {
          target: { mount: string; path: string };
          query: string;
          caseSensitive?: boolean;
          maxResults?: number;
          maxDepth?: number;
        };
        if (
          typeof args.query !== "string" ||
          args.query.length === 0 ||
          args.query.length > 500 ||
          (args.caseSensitive !== undefined &&
            typeof args.caseSensitive !== "boolean")
        )
          throw new Error("invalid grep query");
        // Linear-time engine: model input must never run a backtracking regex in
        // the daemon. Unsupported syntax becomes ExpectedFailure.
        const pattern = RE2JS.compile(
          args.query,
          args.caseSensitive === false ? RE2JS.CASE_INSENSITIVE : 0,
        );
        const limit = searchLimit(args.maxResults, 200);
        const depth = searchDepth(args.maxDepth);
        const matches: Array<{
          path: string;
          line: number;
          column: number;
          text: string;
        }> = [];
        let bytes = 0;
        let truncated = false;
        const searchFile = (file: WalkedFile): boolean => {
          if (file.byteSize > MAX_FILE_BYTES) {
            truncated = true;
            return true;
          }
          if (bytes + file.byteSize > MAX_TOTAL_BYTES) {
            truncated = true;
            return false;
          }
          const content = readRegularText(
            file.path,
            Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - bytes),
          );
          if (content === undefined) {
            truncated = true;
            return true;
          }
          bytes += Buffer.byteLength(content);
          const lines = content.split(/\r?\n/u);
          for (const [index, line] of lines.entries()) {
            const match = pattern.matcher(line);
            if (!match.find()) continue;
            if (matches.length === limit) return false;
            const column = match.start();
            matches.push({
              path: file.mountRelativePath,
              line: index + 1,
              column: column + 1,
              text: line.slice(Math.max(0, column - 100), column + 300),
            });
          }
          return true;
        };
        let isFile = false;
        if (args.target.path !== ".") {
          withSandboxParent(
            sandbox,
            args.target,
            "ReadOnly",
            false,
            (parent, name) => {
              const path = join(parent, name);
              const info = lstatSync(path);
              if (
                info.isSymbolicLink() ||
                (!info.isFile() && !info.isDirectory())
              )
                throw new Error("invalid search target");
              isFile = info.isFile();
              if (
                isFile &&
                !searchFile({
                  path,
                  byteSize: info.size,
                  mountRelativePath: args.target.path,
                })
              )
                truncated = true;
            },
          );
        }
        if (!isFile)
          truncated =
            visitRegularFiles(sandbox, args.target, depth, searchFile) ||
            truncated;
        return {
          settlement: { _tag: "Success" as const },
          observation: searchObservation(matches, truncated),
          resultRef: null,
        };
      }),
    ),
};
