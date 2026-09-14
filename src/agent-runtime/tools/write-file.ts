import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import { toolFromSchema } from "../tool.js";
import { resolveWorkPath } from "./read-file.js";

export function makeWriteFileTool(worktreeRoot: string) {
  return toolFromSchema({
    name: "write_file",
    description: "Create or overwrite a file in the workspace with full content.",
    params: Schema.Struct({ path: Schema.String, content: Schema.String }),
    execute: async (p) => {
      const file = resolveWorkPath(worktreeRoot, p.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, p.content, "utf8");
      return `wrote ${p.path} (${p.content.length} chars)`;
    },
  });
}
