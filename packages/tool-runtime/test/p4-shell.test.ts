import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolIntent } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createShellExecutor, shellPolicy } from "../src/tools/shell.js";

let spawnErrorDiagnostic: {
  readonly code: string;
  readonly message: string;
} | null = null;
const diagnosticSpawnSync = (
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> => {
  const result = spawnSync(executable, args, options);
  const errorCode =
    result.error && "code" in result.error ? result.error.code : undefined;
  const code = typeof errorCode === "string" ? errorCode : undefined;
  const sanitizedMessage = result.error?.message.replace(
    /^spawnSync .+ (?=[A-Z0-9_]+$)/u,
    "spawnSync <executable> ",
  );
  spawnErrorDiagnostic = result.error
    ? {
        code: code ?? "unknown",
        message:
          sanitizedMessage !== undefined &&
          /^spawnSync <executable> [A-Z0-9_]+$/u.test(sanitizedMessage)
            ? sanitizedMessage
            : `${result.error.name}: child process launch failed`,
      }
    : null;
  return result;
};
const diagnosticShellExecutor = createShellExecutor(diagnosticSpawnSync);

const root = mkdtempSync(join(tmpdir(), "p4-shell-"));
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
const sandbox = {
  handleId: "s",
  rootPath: root,
  mounts: [
    {
      ref: "workspace",
      rootPath: root,
      region: { resourceSpaceId: "filesystem", normalizedRegion: {} },
      access: "ReadWrite" as const,
    },
  ],
  writableRegions: [],
};

describe("P4 shell tool + policy", () => {
  it("classifies commands deterministically", () => {
    expect(shellPolicy("ls -la")).toBe("Allow");
    expect(shellPolicy("rm file.txt")).toBe("RequireApproval");
    expect(shellPolicy("sudo rm -rf /")).toBe("Deny");
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
      }),
    );
    const safeObservation = ran.observation.text
      .replaceAll(root, "<workspace>")
      .slice(0, 512);
    expect(
      ran.settlement._tag,
      JSON.stringify({
        actualOutcome: ran.settlement._tag,
        observation: safeObservation,
        spawnError: spawnErrorDiagnostic,
      }),
    ).toBe("Success");
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
      }),
    );
    expect(failed.settlement._tag).toBe("ExpectedFailure");
    expect(JSON.parse(failed.observation.text).exitCode).toBe(7);
  });
});
