import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SandboxHandle } from "@arbor/ports";
import { Effect } from "effect";
import { bounded, type ToolExecutor } from "../runtime.js";

const workspaceMountRoot = (sandbox: SandboxHandle): string => {
  const workspace = sandbox.mounts?.find((mount) => mount.ref === "workspace");
  return resolve(workspace?.rootPath ?? sandbox.rootPath);
};

/**
 * Older/third-party model turns may still contain the trusted host path as a
 * shell cwd.  Convert it only when it is lexically inside the already-open
 * workspace mount.  An outside path is left untouched so the native sandbox
 * can fail closed with PathOutsideAdmittedMount; this helper never widens a
 * mount or authorizes a new resource.
 */
const normalizeWorkspaceCwd = (
  sandbox: SandboxHandle,
  cwd: { readonly mount: string; readonly path: string },
): { readonly mount: string; readonly path: string } => {
  if (cwd.mount !== "workspace" || !isAbsolute(cwd.path)) return cwd;
  const root = workspaceMountRoot(sandbox);
  const candidate = resolve(cwd.path);
  const within = relative(root, candidate);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return cwd;
  }
  return { mount: "workspace", path: within.length === 0 ? "." : within };
};

/** P4 `08` §4 (G6). Deterministic policy evaluation; concrete lists are
 * configurable but the mechanism is contract. */
export type ShellPolicyDecision = "Allow" | "RequireApproval" | "Deny";

// Small full-command allowlist, not a shell parser. Only literal simple
// read-only commands are Allow; compound syntax, wrappers, assignments,
// redirects, substitutions and unknown commands go through P38 approval.
const safeArgument =
  "(?:-[A-Za-z0-9-]+|(?!(?:\\.{2})(?:/|$))[A-Za-z0-9_.-]+(?:/(?!\\.{2}(?:/|$))[A-Za-z0-9_.-]+)*)";
const simpleReadOnly = (name: string) =>
  new RegExp(`^${name}(?:[ \\t]+${safeArgument})*$`, "i");
const SAFE_COMMANDS: ReadonlyArray<RegExp> = [
  simpleReadOnly("pwd"),
  simpleReadOnly("ls"),
  simpleReadOnly("cat"),
  simpleReadOnly("head"),
  simpleReadOnly("tail"),
  simpleReadOnly("wc"),
  simpleReadOnly("stat"),
  simpleReadOnly("Get-ChildItem"),
  simpleReadOnly("Get-Content"),
  simpleReadOnly("Get-Item"),
  simpleReadOnly("Select-String"),
  simpleReadOnly("Test-Path"),
  /^echo(?: [A-Za-z0-9 .,!?:_-]+)?$/i,
  /^Write-Output(?: '[^'\r\n]*')?$/i,
  /^git status(?: --short)?$/i,
  /^command -[vV] [A-Za-z0-9._-]+$/i,
  /^Get-Command [A-Za-z0-9._-]+$/i,
  /^exit [0-9]{1,3}$/i,
  // Exact observed read-only timestamp query. yyyy-MM-dd is quoted data.
  /^Get-ChildItem \| ForEach-Object \{ \$_\.LastWriteTime\.ToString\('yyyy-MM-dd HH:mm:ss\.fff'\) \}$/,
];

const executableName = (value: string): string => {
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? value;
  return basename.replace(/\.(?:exe|com|cmd|bat)$/i, "").toLowerCase();
};

// Hard-deny only directly recognizable literal heads; shell-assembled,
// invoked or otherwise ambiguous spellings are outside the allowlist and must
// go through explicit P38 approval rather than being treated as safe.
const isHardDenied = (command: string): boolean => {
  const trimmed = command.trimStart();
  const headMatch = /^(?:'([^']+)'|"([^"]+)"|([^\s;&|<>$'"(){}]+))/.exec(
    trimmed,
  );
  if (headMatch === null) return false;
  const head = headMatch[1] ?? headMatch[2] ?? headMatch[3];
  if (head === undefined) return false;
  const name = executableName(head);
  if (
    ["sudo", "doas", "su", "runas", "pkexec", "shutdown", "reboot"].includes(
      name,
    ) ||
    name === "mkfs" ||
    name.startsWith("mkfs.")
  )
    return true;
  if (name !== "rm") return false;
  const argumentsText = trimmed.slice(headMatch[0].length).trim();
  if (
    argumentsText.length === 0 ||
    /[\r\n;&|<>$(){}]/.test(argumentsText) ||
    argumentsText.includes(String.fromCharCode(96))
  ) {
    return false;
  }
  const args = (argumentsText.match(/'[^']*'|"[^"]*"|[^\s]+/g) ?? []).map(
    (argument) => argument.replace(/^(['"])(.*)\1$/, "$2"),
  );
  const optionEnd = args.indexOf("--");
  const options = optionEnd < 0 ? args : args.slice(0, optionEnd);
  const targets =
    optionEnd < 0
      ? options.filter((argument) => !argument.startsWith("-"))
      : args.slice(optionEnd + 1);
  const recursive = options.some(
    (argument) =>
      argument === "--recursive" ||
      (argument.startsWith("-") &&
        !argument.startsWith("--") &&
        /r/i.test(argument.slice(1))),
  );
  const force = options.some(
    (argument) =>
      argument === "--force" ||
      (argument.startsWith("-") &&
        !argument.startsWith("--") &&
        /f/i.test(argument.slice(1))),
  );
  return (
    recursive &&
    force &&
    targets.some(
      (target) => target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target),
    )
  );
};

export const shellPolicy = (command: string): ShellPolicyDecision => {
  const normalized = command.trim();
  if (/[\r\n]/.test(normalized)) return "RequireApproval";
  if (isHardDenied(normalized)) return "Deny";
  return SAFE_COMMANDS.some((pattern) => pattern.test(normalized))
    ? "Allow"
    : "RequireApproval";
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
export const createShellExecutor = (): ToolExecutor => ({
  name: "shell",
  write: true,
  processCapability: "SandboxProcess",
  requiresApproval: destructive,
  execute: (input) => {
    const { intent, runProcess, sandbox } = input;
    return Effect.gen(function* () {
      const args = JSON.parse(intent.argumentsJson) as {
        command: string;
        cwd: { mount: string; path: string };
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
      const cwd = normalizeWorkspaceCwd(sandbox, args.cwd);
      const result =
        runProcess === undefined
          ? {
              _tag: "Rejected" as const,
              failureCode: "ProcessCapabilityNotBound",
            }
          : yield* runProcess({
              executable,
              args: shellArgs,
              cwd,
              ...(args.timeoutMs === undefined
                ? {}
                : { requestedTimeoutMs: args.timeoutMs }),
              ambientEnvironment: process.env,
            });
      if (result._tag === "SandboxProviderUnavailable") {
        return {
          settlement: {
            _tag: "ExpectedFailure",
          },
          observation: bounded(
            "required sandbox capability was unavailable or could not be verified; execution did not start",
          ),
          resultRef: null,
          sandboxProviderUnavailable: result,
        };
      }
      if (result._tag === "Rejected") {
        return {
          settlement: {
            _tag: "RuntimeFailure",
            cause: "sandbox process request rejected",
          },
          observation: bounded("sandbox process request rejected"),
          resultRef: null,
        };
      }
      const exitCode = result.exitCode;
      const payload = JSON.stringify({
        exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutRef: "",
        stderrRef: "",
        truncated: result.truncated,
      });
      return {
        settlement: result.timedOut
          ? { _tag: "RuntimeFailure", cause: "shell timeout" }
          : exitCode === 0
            ? { _tag: "Success" }
            : { _tag: "ExpectedFailure" },
        observation: bounded(payload),
        resultRef: null,
      };
    });
  },
});

export const shellExecutor = createShellExecutor();
