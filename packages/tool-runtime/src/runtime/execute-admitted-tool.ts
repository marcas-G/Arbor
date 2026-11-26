import type { CanonicalResourceRegion } from "@arbor/domain";
import type {
  SandboxPortService,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
  ToolRuntimeError,
} from "@arbor/ports";
import { Effect, Exit, Scope } from "effect";
import type { FilesystemAddress } from "../requested-resources.js";
import { operationalFailure } from "./errors.js";
import type { makeProcessRunner } from "./process-runner.js";
import type { ToolExecutionResult, ToolExecutor } from "./types.js";

/** Execute inside the admitted sandbox, or reuse the exact recovered outcome.
 *
 * The sandbox handle is a scoped resource (E07): its close runs under the
 * invocation's own Scope on success, typed failure, defect and interruption
 * alike. The prior hand-written close covered only the typed paths, so an
 * interrupted executor leaked the adapter handle. Close keeps its existing
 * typed contract: a failed close still wins over the executor outcome as
 * `ToolRuntimeCleanupFailure`, and `priorFailure` is preserved when the
 * executor also failed. */
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
): Effect.Effect<ToolExecutionResult, ToolRuntimeError> => {
  if (recoveredToolOutcome !== undefined) {
    return Effect.succeed(recoveredToolOutcome);
  }
  const acquire = sandbox
    .open(
      executor.processCapability === "SandboxProcess" &&
        processExecutionContext.sandboxProcessMountBindings !== undefined
        ? {
            executionId: context.executionId,
            workspaceId: context.workspaceId,
            mounts: processExecutionContext.sandboxProcessMountBindings,
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
                  access: executor.write ? "ReadWrite" : "ReadOnly",
                },
              ],
            },
    )
    .pipe(
      Effect.mapError(
        operationalFailure("SandboxOpen", String(intent.invocationId)),
      ),
    );
  return Effect.scopedWith((scope) =>
    Effect.gen(function* () {
      const handle = yield* acquire;
      let closed: Exit.Exit<void, unknown> | undefined;
      yield* Scope.addFinalizerExit(scope, (exit) =>
        Effect.match(sandbox.close(handle), {
          onFailure: (cause) => {
            closed = Exit.die({ _tag: "SandboxCloseFailed", cause });
            return Effect.void;
          },
          onSuccess: (value) => {
            if (exit._tag !== "Failure") closed = Exit.succeed(value);
            return Effect.void;
          },
        }),
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
      // The scope closes here (releasing the handle); the recorded close
      // outcome keeps the typed CleanupFailure contract. Interruption and
      // defect paths release the handle through this same finalizer without
      // reaching the observation code below.
      yield* Scope.close(scope, Exit.void);
      if (closed !== undefined && closed._tag === "Failure") {
        return yield* Effect.fail<ToolRuntimeError>({
          _tag: "ToolRuntimeCleanupFailure",
          stage: "SandboxClose",
          effectDisposition: "OutcomeUncertain",
          invocationRef: String(intent.invocationId),
          cause: closed.cause,
          ...(!executed.ok
            ? {
                priorFailure: {
                  _tag: "ToolRuntimeOperationalFailure" as const,
                  stage: "Executor" as const,
                  effectDisposition: "OutcomeUncertain" as const,
                  invocationRef: String(intent.invocationId),
                  cause: executed.cause,
                },
              }
            : {}),
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
    }),
  );
};
