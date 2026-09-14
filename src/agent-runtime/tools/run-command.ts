import { execFile, spawn } from "node:child_process";
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

export interface SandboxConfig {
  readonly enabled: boolean;
  readonly allowNetwork?: boolean | undefined;
}

/** P4-03 (D-043 I3): bubblewrap wrapper — system read-only, worktree writable,
 * network off unless explicitly allowed. Missing bwrap with sandbox enabled is
 * a typed error, never a silent unsandboxed fallback. */
function bwrapArgv(argv: string[], worktreeRoot: string, allowNetwork: boolean): string[] {
  return [
    "bwrap",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/etc",
    "/etc",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    worktreeRoot,
    worktreeRoot,
    "--chdir",
    worktreeRoot,
    ...(allowNetwork ? [] : ["--unshare-net"]),
    "--die-with-parent",
    "--",
    ...argv,
  ];
}

async function hasBwrap(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("bwrap", ["--version"], { windowsHide: true }, (err) => {
      resolve(err === null);
    });
  });
}

export function makeRunCommandTool(worktreeRoot: string, sandbox?: SandboxConfig) {
  return toolFromSchema({
    name: "run_command",
    description:
      "Run a command as structured argv (no shell string). Runs in the workspace root. Default timeout 30s, max 120s." +
      (sandbox?.enabled === true
        ? " Executes inside a bubblewrap sandbox: system read-only, only the workspace writable, network off unless allowed."
        : ""),
    params: Schema.Struct({
      argv: Schema.Array(Schema.String),
      timeoutMs: Schema.optional(Schema.Number),
    }),
    execute: async (p) => {
      const timeoutMs = Math.min(p.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if ((p.timeoutMs ?? DEFAULT_TIMEOUT_MS) > MAX_TIMEOUT_MS) {
        throw new Error(`timeoutMs above hard cap (${MAX_TIMEOUT_MS}ms)`);
      }
      let finalArgv = [...p.argv];
      if (sandbox?.enabled === true) {
        if (!(await hasBwrap())) {
          throw new Error(
            "sandbox.enabled is set but bubblewrap is not installed — refusing to run unsandboxed",
          );
        }
        finalArgv = bwrapArgv(finalArgv, worktreeRoot, sandbox.allowNetwork === true);
      }
      const r = await run(finalArgv, worktreeRoot, timeoutMs);
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
