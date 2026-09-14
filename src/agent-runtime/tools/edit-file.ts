import { readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { toolFromSchema } from "../tool.js";
import { resolveWorkPath } from "./read-file.js";

export function makeEditFileTool(worktreeRoot: string) {
  return toolFromSchema({
    name: "edit_file",
    description:
      "Replace an exact string in a file. oldString must match exactly once: zero or multiple matches are errors.",
    params: Schema.Struct({
      path: Schema.String,
      oldString: Schema.String,
      newString: Schema.String,
    }),
    execute: async (p) => {
      const file = resolveWorkPath(worktreeRoot, p.path);
      const content = await readFile(file, "utf8");
      const count = content.split(p.oldString).length - 1;
      if (count === 0) {
        throw new Error(`oldString not found in ${p.path}`);
      }
      if (count > 1) {
        throw new Error(`oldString matches ${count} times in ${p.path}; must be unique`);
      }
      await writeFile(file, content.replace(p.oldString, p.newString), "utf8");
      return `edited ${p.path}`;
    },
  });
}
