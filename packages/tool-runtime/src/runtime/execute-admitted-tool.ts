import type { CanonicalResourceRegion } from "@arbor/domain";
import type {
  SandboxPortService,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
  ToolRuntimeError,
} from "@arbor/ports";
import { Effect } from "effect";
import type { FilesystemAddress } from "../requested-resources.js";
import { operationalFailure } from "./errors.js";
import type { makeProcessRunner } from "./process-runner.js";
import type { ToolExecutionResult, ToolExecutor } from "./types.js";

/** Execute inside the admitted sandbox, or reuse the exact recovered outcome. */
export const executeAdmittedTool = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  processExecutionContext: ToolExecutionContext,
  definition: ToolDefinition,
  executor: ToolExecutor,
  sandbox: SandboxPortService,
  address: FilesystemAddress | undefined,
  region: CanonicalResourceRegion | undefined,
  regions: ReadonlyArray<CanonicalResourceRegion>,
  recoveredToolOutcome: ToolExecutionResult | undefined,
  runProcessFor: ReturnType<typeof makeProcessRunner>,
): Effect.Effect<ToolExecutionResult, ToolRuntimeError> =>
  Effect.gen(function* () {
    const executionBundle =
      recoveredToolOutcome !== undefined
        ? {
            executed: {
              ok: true as const,
              value: recoveredToolOutcome,
            },
            closed: { ok: true as const },
          }
        : yield* Effect.gen(function* () {
            const handle = yield* sandbox
              .open(
                executor.processCapability === "SandboxProcess" &&
                  processExecutionContext.sandboxProcessMountBindings !==
                    undefined
                  ? {
                      executionId: context.executionId,
                      workspaceId: context.workspaceId,
                      mounts:
                        processExecutionContext.sandboxProcessMountBindings,
                    }
                  : address === undefined || region === undefined
                    ? {
                        executionId: context.executionId,
                        workspaceId: context.workspaceId,
                        regions,
                      }
                    : {
                        executionId: context.executionId,
                        workspaceId: context.workspaceId,
                        mounts: [
                          {
                            ref: "workspace",
                            address,
                            region,
                            access: executor.write
                              ? "ReadWrite"
                              : "ReadOnly",
                          },
                        ],
                      },
              )
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "SandboxOpen",
                    String(intent.invocationId),
                  ),
                ),
              );
            const executed = yield* Effect.match(
              executor.execute({
                intent,
                definition,
                context: processExecutionContext,
                sandbox: handle,
                regions,
                ...(executor.processCapability === "SandboxProcess"
                  ? {
                      runProcess: runProcessFor(
                        processExecutionContext,
                        handle,
                        intent,
                      ),
                    }
                  : {}),
              }),
              {
                onFailure: (cause) => ({ ok: false as const, cause }),
                onSuccess: (value) => ({ ok: true as const, value }),
              },
            );
            const closed = yield* Effect.match(sandbox.close(handle), {
              onFailure: (cause) => ({ ok: false as const, cause }),
              onSuccess: () => ({ ok: true as const }),
            });
            return { executed, closed };
          });
    const { executed, closed } = executionBundle;
    if (!closed.ok) {
      return yield* Effect.fail<ToolRuntimeError>({
        _tag: "ToolRuntimeCleanupFailure",
        stage: "SandboxClose",
        effectDisposition: "OutcomeUncertain",
        invocationRef: String(intent.invocationId),
        cause: closed.cause,
        ...(executed.ok
          ? {}
          : {
              priorFailure: {
                _tag: "ToolRuntimeOperationalFailure" as const,
                stage: "Executor" as const,
                effectDisposition: "OutcomeUncertain" as const,
                invocationRef: String(intent.invocationId),
                cause: executed.cause,
              },
            }),
      });
    }
    if (!executed.ok) {
      return yield* Effect.fail<ToolRuntimeError>({
        _tag: "ToolRuntimeOperationalFailure",
        stage: "Executor",
        effectDisposition: "OutcomeUncertain",
        invocationRef: String(intent.invocationId),
        cause: executed.cause,
      });
    }
    return executed.value;
  });
