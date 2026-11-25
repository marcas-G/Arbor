import { matchesGlob } from "node:path";
import { Effect } from "effect";
import type { ToolExecutor } from "../runtime.js";
import { executeFilesystemTool } from "./filesystem-result.js";
import {
  searchDepth,
  searchLimit,
  searchObservation,
  visitRegularFiles,
} from "./filesystem-walk.js";

export const globExecutor: ToolExecutor = {
  name: "glob",
  write: false,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync(() =>
      executeFilesystemTool(() => {
        const args = JSON.parse(intent.argumentsJson) as {
          target: { mount: string; path: string };
          pattern: string;
          maxResults?: number;
          maxDepth?: number;
        };
        if (
          typeof args.pattern !== "string" ||
          args.pattern.length === 0 ||
          args.pattern.length > 500 ||
          args.pattern.startsWith("/") ||
          args.pattern.includes("\\") ||
          args.pattern.includes("\0") ||
          args.pattern.split("/").includes("..")
        )
          throw new Error("invalid glob");
        const limit = searchLimit(args.maxResults, 500);
        const matches: string[] = [];
        const truncated = visitRegularFiles(
          sandbox,
          args.target,
          searchDepth(args.maxDepth),
          (file) => {
            const relative =
              args.target.path === "."
                ? file.mountRelativePath
                : file.mountRelativePath.slice(args.target.path.length + 1);
            if (matchesGlob(relative, args.pattern)) {
              if (matches.length === limit) return false;
              matches.push(file.mountRelativePath);
            }
            return true;
          },
        );
        return {
          settlement: { _tag: "Success" as const },
          observation: searchObservation(matches.sort(), truncated),
          resultRef: null,
        };
      }),
    ),
};
