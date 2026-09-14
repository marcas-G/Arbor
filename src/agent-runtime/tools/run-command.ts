import { spawn } from "node:child_process";
import { Schema } from "effect";
import { toolFromSchema } from "../tool.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

interface RunOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function run(argv: string[], cwd: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${String(err)}`, code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

export function makeRunCommandTool(worktreeRoot: string) {
  return toolFromSchema({
    name: "run_command",
    description:
      "Run a command as structured argv (no shell string). Runs in the workspace root. Default timeout 30s, max 120s.",
    params: Schema.Struct({
      argv: Schema.Array(Schema.String),
      timeoutMs: Schema.optional(Schema.Number),
    }),
    execute: async (p) => {
      const timeoutMs = Math.min(p.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if ((p.timeoutMs ?? DEFAULT_TIMEOUT_MS) > MAX_TIMEOUT_MS) {
        throw new Error(`timeoutMs above hard cap (${MAX_TIMEOUT_MS}ms)`);
      }
      const r = await run([...p.argv], worktreeRoot, timeoutMs);
      const out = [r.stdout.trim(), r.stderr.trim()].filter((s) => s.length > 0).join("\n");
      if (r.timedOut) {
        throw new Error(`timeout after ${timeoutMs}ms\n${out}`);
      }
      if (r.code !== 0) {
        throw new Error(`exit=${r.code}\n${out}`);
      }
      return out || "(no output)";
    },
  });
}
