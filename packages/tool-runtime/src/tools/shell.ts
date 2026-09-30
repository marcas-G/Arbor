import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import {
  bounded,
  type ToolExecutionResult,
  type ToolExecutor,
} from "../runtime.js";

/** P4 `08` §4 (G6). Deterministic policy evaluation; concrete lists are
 * configurable but the mechanism is contract. */
export type ShellPolicyDecision = "Allow" | "RequireApproval" | "Deny";

const DENY = /\b(sudo|mkfs|shutdown|reboot|rm\s+-rf\s+\/)\b/;
const REQUIRE_APPROVAL = /\b(rm|mv|chmod|chown|dd|truncate|git\s+push)\b/;

export const shellPolicy = (command: string): ShellPolicyDecision => {
  if (DENY.test(command)) {
    return "Deny";
  }
  if (REQUIRE_APPROVAL.test(command)) {
    return "RequireApproval";
  }
  return "Allow";
};

const destructive = (intent: { readonly argumentsJson: string }): boolean => {
  try {
    const parsed = JSON.parse(intent.argumentsJson) as { command?: string };
    return shellPolicy(parsed.command ?? "") === "RequireApproval";
  } catch {
    return true;
  }
};

/** P4 `08` §4. Reconcilable: reconcile before replay on ambiguity. */
export const shellExecutor: ToolExecutor = {
  name: "shell",
  write: true,
  requiresApproval: destructive,
  execute: ({ intent, sandbox }) =>
    Effect.sync((): ToolExecutionResult => {
      const args = JSON.parse(intent.argumentsJson) as {
        command: string;
        timeoutMs?: number;
      };
      const decision = shellPolicy(args.command);
      if (decision === "Deny") {
        return {
          settlement: { _tag: "ExpectedFailure" },
          observation: bounded("command denied by shell policy"),
          resultRef: null,
        };
      }
      const executable = process.platform === "win32" ? "pwsh" : "bash";
      const shellArgs =
        process.platform === "win32"
          ? ["-NoProfile", "-NonInteractive", "-Command", args.command]
          : ["-lc", args.command];
      const result = spawnSync(executable, shellArgs, {
        cwd: sandbox.rootPath,
        timeout: args.timeoutMs ?? 10_000,
        encoding: "utf8",
      });
      const exitCode = result.status ?? 1;
      const payload = JSON.stringify({
        exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        stdoutRef: "",
        stderrRef: "",
        truncated: false,
      });
      return {
        settlement:
          result.error?.name === "ETIMEDOUT"
            ? { _tag: "RuntimeFailure", cause: "shell timeout" }
            : exitCode === 0
              ? { _tag: "Success" }
              : { _tag: "ExpectedFailure" },
        observation: bounded(payload),
        resultRef: null,
      };
    }),
};
