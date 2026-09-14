import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { normalizeProjectPath } from "../../domain/project-path.js";
import { toolFromSchema } from "../tool.js";

const READ_LIMIT = 256 * 1024;

export function resolveWorkPath(worktreeRoot: string, rawPath: string): string {
  const n = normalizeProjectPath(rawPath);
  if (n.kind === "err") {
    throw new Error(`bad path (${n.reason}): ${rawPath}`);
  }
  return join(worktreeRoot, n.value);
}

export function makeReadFileTool(worktreeRoot: string) {
  return toolFromSchema({
    name: "read_file",
    description:
      "Read a file from the workspace. Path is workspace-relative, '/'-separated, no absolute paths or '..'.",
    params: Schema.Struct({ path: Schema.String }),
    execute: async (p) => {
      const file = resolveWorkPath(worktreeRoot, p.path);
      const content = await readFile(file, "utf8");
      if (content.length > READ_LIMIT) {
        throw new Error(`file exceeds read limit (${READ_LIMIT} chars)`);
      }
      return content;
    },
  });
}
