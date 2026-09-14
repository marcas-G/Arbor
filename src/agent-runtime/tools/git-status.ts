import { execFile } from "node:child_process";
import { Schema } from "effect";
import { toolFromSchema } from "../tool.js";

function gitStatus(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "status", "--porcelain"], { windowsHide: true }, (err, stdout) => {
      if (err !== null) {
        reject(new Error(`git status failed: ${String(err)}`));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

export function makeGitStatusTool(worktreeRoot: string) {
  return toolFromSchema({
    name: "git_status",
    description: "Show git working-tree status (porcelain format) of the workspace worktree.",
    params: Schema.Struct({}),
    execute: async () => {
      const out = await gitStatus(worktreeRoot);
      return out.trim() || "(clean)";
    },
  });
}
