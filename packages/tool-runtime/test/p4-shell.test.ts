import {
  projectSandboxEnvironment,
  type SandboxProcessRunner,
  type ToolExecutionContext,
  type ToolIntent,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createShellExecutor, shellPolicy } from "../src/tools/shell.js";

const diagnosticShellExecutor = createShellExecutor();
const intent = (command: string): ToolIntent => ({
  callRef: "c",
  toolName: "shell",
  toolVersion: "2",
  argumentsJson: JSON.stringify({
    command,
    cwd: { mount: "workspace", path: "." },
  }),
  invocationId: "tin_x" as never,
  approvalId: null,
});
const context = {} as ToolExecutionContext;
const sandbox = {} as never;
const testProcess: SandboxProcessRunner = ({ args: processArgs }) =>
  Effect.succeed({
    _tag: "Completed" as const,
    exitCode: processArgs.at(-1) === "exit 7" ? 7 : 0,
    stdout: processArgs.at(-1) === "echo hi" ? "hi\n" : "",
    stderr: "",
    timedOut: false,
    truncated: false,
  });

describe("P4 shell tool + policy", () => {
  it("classifies commands deterministically", () => {
    expect(shellPolicy("ls -la")).toBe("Allow");
    expect(shellPolicy("rm file.txt")).toBe("RequireApproval");
    expect(shellPolicy("sudo rm -rf /")).toBe("Deny");
  });

  it("allows only reviewed simple read-only commands and the exact date query", () => {
    for (const command of [
      "pwd",
      "cat proof.txt",
      "head -n 3 proof.txt",
      "Get-ChildItem .",
      "Get-Content proof.txt",
      "echo hi",
      "Write-Output 'rm -rf /'",
      "git status --short",
    ]) {
      expect(shellPolicy(command), command).toBe("Allow");
    }
    expect(
      shellPolicy(
        "Get-ChildItem | ForEach-Object { $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss.fff') }",
      ),
    ).toBe("Allow");
    expect(shellPolicy("Write-Output 'yyyy-MM-dd'")).toBe("Allow");
  });

  it.each([
    "dd if=input.bin of=output.bin",
    "python -c 'print(1)'",
    "ls -la; rm file.txt",
    "ls\nrm file.txt",
    "ls\r\nshutdown now",
    "2>/dev/null dd if=input.bin of=output.bin",
    "FOO=bar dd if=input.bin of=output.bin",
    "bash -c 'sudo rm -rf /'",
    "s'u'do rm -rf /",
    "r'm' -rf /",
    "& 'sudo' rm -rf /",
    "setsid 'bash' /tmp/payload.sh",
    "Get-ChildItem . | ForEach-Object { Invoke-Expression 'sudo rm -rf /' }",
    "Get-Content ../outside.txt",
  ])("requires P38 approval for unallowlisted command %s", (command) => {
    expect(shellPolicy(command), command).toBe("RequireApproval");
    expect(diagnosticShellExecutor.requiresApproval(intent(command))).toBe(
      true,
    );
  });

  it.each([
    "sudo 'echo hi'",
    "'sudo' rm -rf /",
    "/bin/rm -rf /",
    "rm -rf -- /",
    "rm --recursive --force /",
    "mkfs.ext4 /dev/sda",
    "shutdown now",
    "reboot",
    "rm -rf /tmp",
  ])("denies a direct hard-danger simple command %s", (command) => {
    expect(shellPolicy(command), command).toBe("Deny");
  });

  it("requires approval for a destructive command", () => {
    expect(diagnosticShellExecutor.requiresApproval(intent("rm x"))).toBe(true);
    expect(diagnosticShellExecutor.requiresApproval(intent("ls"))).toBe(false);
  });

  it("denies a policy-denied command and runs an allowed one", async () => {
    const denied = await Effect.runPromise(
      diagnosticShellExecutor.execute({
        intent: intent("sudo rm -rf /"),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
        runProcess: testProcess,
      }),
    );
    expect(denied.settlement._tag).toBe("ExpectedFailure");
    const ran = await Effect.runPromise(
      diagnosticShellExecutor.execute({
        intent: intent("echo hi"),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
        runProcess: testProcess,
      }),
    );
    expect(ran.settlement._tag).toBe("Success");
    expect(JSON.parse(ran.observation.text)).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("hi"),
    });
    const failed = await Effect.runPromise(
      diagnosticShellExecutor.execute({
        intent: intent("exit 7"),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
        runProcess: testProcess,
      }),
    );
    expect(failed.settlement._tag).toBe("ExpectedFailure");
    expect(JSON.parse(failed.observation.text).exitCode).toBe(7);
  });

  it("projects the policy allow-list at the sandbox provider boundary", async () => {
    const previous = {
      LANG: process.env.LANG,
      SECRET: process.env.SECRET,
      API_KEY: process.env.API_KEY,
    };
    process.env.LANG = "p4-shell-test-locale";
    process.env.SECRET = "must-not-leak";
    process.env.API_KEY = "must-not-leak-either";
    let captured: NodeJS.ProcessEnv | undefined;
    const runProcess: SandboxProcessRunner = ({ ambientEnvironment }) => {
      captured = projectSandboxEnvironment(ambientEnvironment, ["LANG"]);
      return Effect.succeed({
        _tag: "Completed" as const,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        truncated: false,
      });
    };
    const executor = createShellExecutor();

    try {
      const result = await Effect.runPromise(
        executor.execute({
          intent: {
            ...intent("echo hi"),
            argumentsJson: JSON.stringify({
              command: "echo hi",
              cwd: { mount: "workspace", path: "." },
              timeoutMs: 3210,
            }),
          },
          definition: {} as never,
          context,
          sandbox,
          regions: [],
          runProcess,
        }),
      );

      expect(result.settlement._tag).toBe("Success");
      expect(captured).toBeDefined();
      if (captured === undefined)
        throw new Error("process port was not called");
      const env = captured;
      expect(env.LANG).toBe("p4-shell-test-locale");
      expect(env.SECRET).toBeUndefined();
      expect(env.API_KEY).toBeUndefined();
      expect(Object.keys(env)).toEqual(["LANG"]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
