import { execFileSync } from "node:child_process";
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
      try {
        const stdout = execFileSync("sh", ["-c", args.command], {
          cwd: sandbox.rootPath,
          timeout: args.timeoutMs ?? 10_000,
          encoding: "utf8",
        });
        return {
          settlement: { _tag: "Success" },
          observation: bounded(
            JSON.stringify({
              exitCode: 0,
              stdoutRef: "",
              stderrRef: "",
              truncated: false,
            }),
          ),
          resultRef: null,
        };
      } catch (error) {
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status: unknown }).status)
            : 1;
        return {
          settlement: { _tag: "Success" },
          observation: bounded(
            JSON.stringify({
              exitCode: status,
              stdoutRef: "",
              stderrRef: "",
              truncated: false,
            }),
          ),
          resultRef: null,
        };
      }
    }),
};
