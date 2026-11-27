import type {
  SandboxHandle,
  ToolExecutionContext,
  ToolIntent,
} from "@arbor/ports";
import type { ToolExecutor } from "../src/index.js";

/**
 * Shared executor-facing harness for the filesystem tool suites (read, list,
 * patch, glob, grep, write): the same intent/context/sandbox triple each
 * suite previously hand-rolled at module scope.
 */
export const fsToolSandbox = (
  root: string,
  access: "ReadOnly" | "ReadWrite",
): SandboxHandle => ({
  handleId: "s",
  rootPath: root,
  writableRegions: [],
  mounts: [
    {
      ref: "workspace",
      rootPath: root,
      region: { resourceSpaceId: "filesystem", normalizedRegion: {} },
      access,
    },
  ],
});

export const executeFsTool = (
  executor: ToolExecutor,
  input: {
    readonly toolName: string;
    readonly toolVersion: string;
    readonly argumentsJson: string;
    readonly invocationId?: string;
  },
  sandbox: SandboxHandle,
): ReturnType<ToolExecutor["execute"]> =>
  executor.execute({
    intent: {
      callRef: "c",
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      argumentsJson: input.argumentsJson,
      invocationId: (input.invocationId ?? "tin_x") as never,
      approvalId: null,
    } satisfies ToolIntent,
    definition: {} as never,
    context: {} as ToolExecutionContext,
    sandbox,
    regions: [],
  });
